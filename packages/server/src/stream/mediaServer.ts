import { EventEmitter } from 'node:events';
// node-media-server ships no types; see types/node-media-server.d.ts
import NodeMediaServer from 'node-media-server';
import type { OverseerConfig } from '../config.js';
import type { StreamInfo } from '../atem/runner.js';
import { log } from '../diag/index.js';

/**
 * Bundled RTMP ingest. Each ATEM is pointed (via the generated Streaming.xml)
 * at rtmp://<host>:<rtmpPort>/live/<deviceId>. We then expose the same feed as
 * low-latency http-flv at http://<host>:<httpPort>/live/<deviceId>.flv, which
 * mpegts.js plays directly in the browser — no transcode, no ffmpeg.
 *
 * The stream key IS the device id, which is how a published stream is matched
 * back to the device tile it belongs to.
 */
export class MediaServer extends EventEmitter {
  private nms: NodeMediaServer;
  private live = new Set<string>();

  constructor(private cfg: OverseerConfig) {
    super();
    // v4 honours only `port` in each section; v2's chunk_size/gop_cache/ping/
    // allow_origin/mediaroot/logType are silently ignored, so they are gone
    // rather than left here reading as settings that do something. CORS is
    // wide open by default in v4, which is what the flv tiles need.
    this.nms = new NodeMediaServer({
      rtmp: { port: cfg.rtmpPort },
      http: { port: cfg.mediaHttpPort },
    });

    // ONE session object per event since v4 (v2 passed `(id, streamPath, args)`).
    // Getting this wrong does not fail to compile and does not degrade quietly:
    // the throw lands in node-media-server's synchronous emit, which is inside
    // the RTMP parser, so it surfaces as an uncaughtException and kills the
    // whole dashboard the instant a switcher starts streaming.
    this.nms.on('postPublish', (session) => {
      const key = streamKey(session?.streamPath);
      if (!key) return;
      this.live.add(key);
      this.emit('liveChanged', key, true);
    });
    this.nms.on('donePublish', (session) => {
      const key = streamKey(session?.streamPath);
      if (!key) return;
      this.live.delete(key);
      this.emit('liveChanged', key, false);
    });
  }

  /**
   * `Promise.resolve(...)` rather than `.catch()` on the return value: run()
   * and stop() went async during v4 (4.2 returns undefined, 4.4 a promise),
   * so calling .catch() directly crashes on the older one and letting the
   * promise float loses a failed bind on the newer. This form is correct for
   * both, which is what a hand-typed dependency deserves.
   */
  start(): void {
    void Promise.resolve(this.nms.run()).catch((err: unknown) => {
      log.error({ err: (err as Error).message }, 'RTMP ingest failed to start');
    });
  }

  stop(): void {
    void Promise.resolve(this.nms.stop()).catch(() => {
      /* shutting down anyway */
    });
  }

  streamInfo = (id: string): StreamInfo => {
    const base = `http://${this.cfg.publicHost}:${this.cfg.mediaHttpPort}/live/${id}.flv`;
    return { flvUrl: base, live: this.live.has(id) };
  };

  isLive(id: string): boolean {
    return this.live.has(id);
  }
}

function streamKey(streamPath: string | undefined): string | null {
  // "/live/cam-a" -> "cam-a". Takes undefined because the value comes from a
  // hand-typed third-party surface: a tile that stays NO SIGNAL is a far better
  // failure than a TypeError thrown through the RTMP parser.
  const parts = (streamPath ?? '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}
