// ---- datarhei Core v3 wire types (subset we use) ----

export interface CoreProcessIO {
  id: string;
  address: string;
  options?: string[];
}

export interface CoreProcessConfig {
  id: string;
  reference?: string;
  type?: 'ffmpeg';
  options?: string[];
  autostart?: boolean;
  reconnect?: boolean;
  reconnect_delay_seconds?: number;
  stale_timeout_seconds?: number;
  input: CoreProcessIO[];
  output: CoreProcessIO[];
}

/** Runtime state as reported by GET /api/v3/process/{id} (subset). */
export interface CoreProcessState {
  order?: string; // "start" | "stop"
  exec?: string; // "running" | "finished" | "failed" | "starting" | "finishing"
  progress?: unknown;
  reconnect_seconds?: number;
  last_logline?: string;
}

export interface CoreProcess {
  id: string;
  reference?: string;
  config?: CoreProcessConfig;
  state?: CoreProcessState;
}

/** Minimal fetch surface so the client can run on Node's global fetch, a
 *  polyfill, or an in-memory mock without depending on any of them. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

// ---- split-channel abstraction (framework-agnostic) ----

export interface Destination {
  id: string;
  name: string;
  /** RTMP/SRT base URL, e.g. rtmp://a.rtmp.youtube.com/live2 */
  url: string;
  /** optional stream key appended as a path segment */
  streamKey?: string;
  enabled: boolean;
}

/** How the encoder reaches the built-in RTMP ingest of the Core/Restreamer. */
export interface RtmpIngestConfig {
  /** host/ip the encoder (ATEM) reaches the Restreamer at */
  host: string;
  port: number;
  /**
   * RTMP application/path segment. **Must match the Core's own `rtmp.app`.**
   * A stock Restreamer uses "/", i.e. none — pass "" for that. Getting this
   * wrong is silent: everything runs and no video arrives.
   */
  app: string;
  /** optional RTMP token required by Restreamer for publishing */
  token?: string;
}

// ---- channel sources ----

/**
 * What feeds a channel. Whatever the kind, the *split* always reads the Core's
 * internal RTMP stream and fans it out with `-c copy` — so everything below is
 * about how the bytes get *into* that stream:
 *
 * - `rtmp`    an encoder (an ATEM, OBS, …) publishes to it directly.
 * - `file`    an upstream Core process plays a file into it.
 * - `browser` an external renderer (WebLinked) publishes a rendered page to it.
 *
 * Downstream of the ingest all three are indistinguishable, which is the point:
 * the monitor copy and every destination keep working untouched.
 */
export type ChannelSource = RtmpSource | FileSource | BrowserSource;

/** The original behaviour, and the default: something else publishes to us. */
export interface RtmpSource {
  kind: 'rtmp';
  /** internal ingest stream name; defaults to the channel id */
  name?: string;
}

/**
 * A media file played out in real time by an upstream Core process. `path` is
 * resolved on the *Core's* filesystem, not the host app's.
 */
export interface FileSource {
  kind: 'file';
  /**
   * Path inside the Core's disk filesystem (`media/loop.mp4`), or any address
   * ffmpeg can open on its own (`http://…/clip.mp4`, `/absolute/path.mov`).
   * Relative paths are expanded to Core's `{diskfs}` placeholder.
   */
  path: string;
  /** play forever (`-stream_loop -1`) rather than once */
  loop?: boolean;
  /**
   * Add a silent stereo track when the file has no audio. Most platforms drop
   * or reject a video-only RTMP stream, and a file with no audio is a common
   * way to discover that mid-show.
   */
  silentAudio?: boolean;
  /** leave unset to stream-copy; set to re-encode into something RTMP-safe */
  encode?: EncodeSettings;
}

/**
 * A web page rendered to video by an external renderer that publishes into the
 * Core's RTMP ingest. The Core only ever sees RTMP; the fields here are what the
 * *renderer* is told, so one channel owns the whole chain rather than leaving
 * half of it configured somewhere else.
 */
export interface BrowserSource {
  kind: 'browser';
  /** the page to render */
  url: string;
  /** internal ingest stream name; defaults to the channel id */
  name?: string;
  /** renderer raster, e.g. 1920x1080 */
  width?: number;
  height?: number;
  /**
   * Frame rate as an exact rational — "50", "25", "60000/1001". A decimal like
   * 59.94 is not the same rate and drifts; the renderer rejects one.
   */
  frameRate?: string;
  /** target video bitrate for the renderer's encoder, e.g. "6000k" */
  videoBitrate?: string;
  /** how to reach the renderer's control API; without it the channel is
   *  provisioned but nobody is told to start rendering */
  renderer?: RendererConfig;
}

/** How to reach a WebLinked-compatible renderer's control API. */
export interface RendererConfig {
  /** control API base, e.g. http://weblinked.local:7654 */
  url: string;
  /** bearer token, when the renderer was started with one */
  token?: string;
  /** which pipeline, on a renderer running several; omit for its primary */
  sourceId?: string;
}

/** Re-encode settings for a source that can't be passed through untouched. */
export interface EncodeSettings {
  /** 'copy' only works when the file is already H.264 */
  video: 'copy' | 'h264';
  /** 'copy' only works when the file is already AAC */
  audio: 'copy' | 'aac';
  /** e.g. "6000k" */
  videoBitrate?: string;
  /** e.g. "128k" */
  audioBitrate?: string;
  /** x264 preset; faster presets cost bitrate, not latency */
  preset?: string;
  /** keyframe interval in seconds — platforms want 2 */
  gopSeconds?: number;
  /** output frame rate; also sets the keyframe interval in frames */
  fps?: number;
  /** output raster, e.g. "1920x1080" */
  size?: string;
}

export interface SplitSpec {
  /** namespacing prefix so multiple apps can share one Restreamer without
   *  clobbering each other's processes, e.g. "atem-overseer" or "flock" */
  referencePrefix: string;
  /** logical channel id, typically the device id */
  channelId: string;
  /** internal ingest stream name (defaults to channelId) */
  ingestName?: string;
  /** where the automatic monitor copy is pushed — the host app's own ingest */
  monitorUrl: string;
  destinations: Destination[];
  /** what feeds the ingest; defaults to `{ kind: 'rtmp' }` */
  source?: ChannelSource;
}

/** Runtime state of the upstream process that feeds the ingest, when a source
 *  kind needs one. Absent for `rtmp` and `browser`, which have no Core process
 *  of their own. */
export interface SourceProcessState {
  processId: string;
  provisioned: boolean;
  running: boolean;
  exec?: string;
  lastLog?: string;
}

export interface ChannelState {
  channelId: string;
  processId: string;
  provisioned: boolean;
  running: boolean;
  /** raw Core exec state, when known */
  exec?: string;
  lastLog?: string;
  /** URL the encoder should publish to */
  ingestPushUrl: string;
  monitorUrl: string;
  destinations: Destination[];
  /** what feeds this channel */
  source: ChannelSource;
  /** the upstream feeder process, for source kinds that have one */
  sourceProcess?: SourceProcessState;
  /** what the renderer reported, for a `browser` source with a `renderer` set */
  renderer?: RendererState;
}

/** What a browser source's renderer says about itself. */
export interface RendererState {
  reachable: boolean;
  /** the page the renderer currently has loaded */
  loadedUrl?: string;
  /** true when the renderer has a running stream output aimed at our ingest */
  publishing?: boolean;
  error?: string;
}
