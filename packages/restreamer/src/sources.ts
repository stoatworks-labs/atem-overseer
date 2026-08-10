import type {
  ChannelSource,
  CoreProcessConfig,
  CoreProcessIO,
  EncodeSettings,
  FileSource,
  SplitSpec,
} from './types.js';

/** The default source: something else publishes to the Core's RTMP ingest. */
export const DEFAULT_SOURCE: ChannelSource = { kind: 'rtmp' };

/** The internal stream name this channel's ingest uses. */
export function ingestNameFor(spec: Pick<SplitSpec, 'channelId' | 'ingestName' | 'source'>): string {
  const source = spec.source ?? DEFAULT_SOURCE;
  const fromSource = source.kind === 'file' ? undefined : source.name;
  return spec.ingestName || fromSource || spec.channelId;
}

/**
 * Only some source kinds need a Core process of their own. `rtmp` has an
 * external encoder and `browser` has an external renderer — in both cases
 * something outside the Core is already publishing, and inventing a process to
 * "manage" it would only give operators something that can be running while no
 * video exists.
 */
export function needsSourceProcess(source: ChannelSource): boolean {
  return source.kind === 'file';
}

/**
 * Validate untrusted input (a REST body, a config file) into a ChannelSource.
 * Throws with an operator-readable reason rather than returning a partly-built
 * source: a channel provisioned from a half-understood body is worse than one
 * that refused to change.
 *
 * Lives here so every app that ports this package rejects the same things.
 */
export function parseChannelSource(input: unknown): ChannelSource {
  if (input === undefined || input === null) return DEFAULT_SOURCE;
  if (typeof input !== 'object') throw new Error('source must be an object');
  const raw = input as Record<string, unknown>;
  const kind = raw.kind ?? 'rtmp';

  if (kind === 'rtmp') {
    return { kind: 'rtmp', ...(raw.name ? { name: String(raw.name) } : {}) };
  }

  if (kind === 'file') {
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!path) throw new Error('a file source needs a path');
    const encode = raw.encode as Record<string, unknown> | undefined;
    return {
      kind: 'file',
      path,
      loop: raw.loop === undefined ? true : !!raw.loop,
      silentAudio: !!raw.silentAudio,
      ...(encode
        ? {
            encode: {
              video: encode.video === 'h264' ? 'h264' : 'copy',
              audio: encode.audio === 'aac' ? 'aac' : 'copy',
              ...(encode.videoBitrate ? { videoBitrate: String(encode.videoBitrate) } : {}),
              ...(encode.audioBitrate ? { audioBitrate: String(encode.audioBitrate) } : {}),
              ...(encode.preset ? { preset: String(encode.preset) } : {}),
              ...(encode.gopSeconds ? { gopSeconds: Number(encode.gopSeconds) } : {}),
              ...(encode.fps ? { fps: Number(encode.fps) } : {}),
              ...(encode.size ? { size: String(encode.size) } : {}),
            },
          }
        : {}),
    };
  }

  if (kind === 'browser') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) throw new Error('a browser source needs a url');
    const renderer = raw.renderer as Record<string, unknown> | undefined;
    const rendererUrl = typeof renderer?.url === 'string' ? renderer.url.trim() : '';
    // A decimal frame rate is a different rate from the rational it looks like,
    // so reject it here rather than let the renderer drift for the show.
    const frameRate = raw.frameRate === undefined ? undefined : String(raw.frameRate).trim();
    if (frameRate && !/^\d+(\/\d+)?$/.test(frameRate)) {
      throw new Error(`frameRate must be an integer or an exact rational like 60000/1001, not "${frameRate}"`);
    }
    return {
      kind: 'browser',
      url,
      ...(raw.name ? { name: String(raw.name) } : {}),
      ...(raw.width ? { width: Number(raw.width) } : {}),
      ...(raw.height ? { height: Number(raw.height) } : {}),
      ...(frameRate ? { frameRate } : {}),
      ...(raw.videoBitrate ? { videoBitrate: String(raw.videoBitrate) } : {}),
      ...(rendererUrl
        ? {
            renderer: {
              url: rendererUrl,
              ...(renderer?.token ? { token: String(renderer.token) } : {}),
              ...(renderer?.sourceId ? { sourceId: String(renderer.sourceId) } : {}),
            },
          }
        : {}),
    };
  }

  throw new Error(`unknown source kind "${String(kind)}"`);
}

/** Core process id of the upstream feeder, derived from the split's id. */
export function sourceProcessIdFor(splitProcessId: string): string {
  return `${splitProcessId}-src`;
}

/**
 * Resolve a file source's path to an ffmpeg input address. A bare relative path
 * is taken to live in the Core's own disk filesystem — that is where an upload
 * through the Core API lands, and it is the only location the Core is
 * guaranteed to be able to read. Anything already carrying a scheme, or an
 * absolute path, is passed through untouched.
 */
export function fileAddress(path: string): string {
  const trimmed = path.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  return `{diskfs}/${trimmed.replace(/^\.?\//, '')}`;
}

const DEFAULT_ENCODE: EncodeSettings = { video: 'copy', audio: 'copy' };

/**
 * Encoder options for the *feeder* process. The split downstream is always
 * `-c copy`, so this is the only place a channel ever pays for an encode —
 * once, no matter how many destinations it fans out to.
 */
export function encodeOptions(source: FileSource): string[] {
  const enc: EncodeSettings = { ...DEFAULT_ENCODE, ...source.encode };
  const opts: string[] = [];

  // With a silence input present, ffmpeg's default stream selection would pick
  // whichever audio track looks "best" across *both* inputs. Be explicit.
  if (source.silentAudio) opts.push('-map', '0:v:0', '-map', '1:a:0');

  if (enc.video === 'copy') {
    opts.push('-c:v', 'copy');
  } else {
    opts.push('-c:v', 'libx264', '-preset', enc.preset ?? 'veryfast', '-pix_fmt', 'yuv420p');
    if (enc.videoBitrate) {
      opts.push('-b:v', enc.videoBitrate, '-maxrate', enc.videoBitrate, '-bufsize', doubleRate(enc.videoBitrate));
    }
    if (enc.size) opts.push('-s', enc.size);
    if (enc.fps) {
      opts.push('-r', String(enc.fps));
      opts.push('-g', String(Math.max(1, Math.round(enc.fps * (enc.gopSeconds ?? 2)))));
    }
  }

  // A lavfi silence track is raw PCM — there is nothing to copy.
  const audio = source.silentAudio ? 'aac' : enc.audio;
  if (audio === 'copy') {
    opts.push('-c:a', 'copy');
  } else {
    opts.push('-c:a', 'aac', '-b:a', enc.audioBitrate ?? '128k', '-ar', '48000', '-ac', '2');
  }

  opts.push('-f', 'flv');
  return opts;
}

/** "6000k" -> "12000k"; anything unparseable is passed through unchanged. */
function doubleRate(rate: string): string {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(rate.trim());
  if (!m) return rate;
  return `${Number(m[1]) * 2}${m[2]}`;
}

/**
 * Build the upstream Core process that plays a source into the channel's
 * internal RTMP stream, or null for kinds that are fed from outside the Core.
 *
 * Pure: no I/O, so it can be asserted on directly.
 */
export function buildSourceProcessConfig(
  spec: SplitSpec,
  splitProcessId: string,
): CoreProcessConfig | null {
  const source = spec.source ?? DEFAULT_SOURCE;
  if (source.kind !== 'file') return null;

  const ingestName = ingestNameFor(spec);
  const input: CoreProcessIO[] = [
    {
      id: 'file',
      address: fileAddress(source.path),
      // `-re` paces the read at wall-clock speed — without it ffmpeg reads the
      // file as fast as it can and the whole clip lands in the ingest in
      // seconds. `+genpts` rebuilds timestamps, which a looping input needs
      // because each restart resets them to zero.
      options: [
        '-re',
        '-fflags',
        '+genpts',
        ...(source.loop === false ? [] : ['-stream_loop', '-1']),
      ],
    },
  ];
  if (source.silentAudio) {
    input.push({
      id: 'silence',
      address: 'anullsrc=r=48000:cl=stereo',
      options: ['-f', 'lavfi'],
    });
  }

  return {
    id: sourceProcessIdFor(splitProcessId),
    reference: `${spec.referencePrefix}:${spec.channelId}:source`,
    type: 'ffmpeg',
    autostart: true,
    reconnect: true,
    reconnect_delay_seconds: 5,
    // A file that plays once is *meant* to end; a stale timeout would keep
    // restarting it. Looping and non-looping want opposite answers here.
    stale_timeout_seconds: source.loop === false ? 0 : 30,
    options: ['-err_detect', 'ignore_err'],
    input,
    output: [
      {
        id: 'ingest',
        address: `{rtmp,name=${ingestName}}`,
        options: encodeOptions(source),
      },
    ],
  };
}
