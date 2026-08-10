import type { RestreamerClient } from './coreClient.js';
import { createRenderer, rendererOutputName } from './browserRenderer.js';
import {
  DEFAULT_SOURCE,
  buildSourceProcessConfig,
  ingestNameFor,
  needsSourceProcess,
  sourceProcessIdFor,
} from './sources.js';
import type {
  ChannelSource,
  ChannelState,
  CoreProcessConfig,
  Destination,
  FetchLike,
  RtmpIngestConfig,
  SourceProcessState,
  SplitSpec,
} from './types.js';

/** Core process ids are lowercase, alnum + `_`/`-`. */
export function processIdFor(referencePrefix: string, channelId: string): string {
  return `${referencePrefix}_${channelId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function joinRtmp(url: string, streamKey?: string): string {
  if (!streamKey) return url;
  return `${url.replace(/\/+$/, '')}/${streamKey}`;
}

/**
 * The URL whatever feeds this channel publishes to, so the Core picks the
 * stream up.
 *
 * **The app segment must match the Core's own `rtmp.app`, and on a stock
 * Restreamer that is `/` — meaning no segment at all.** `{rtmp,name=cam-a}`
 * then expands to `rtmp://localhost:1935/cam-a`, so an encoder pointed at
 * `…/live/cam-a` publishes a stream the split is not listening to: both
 * processes run, both report healthy, and no video ever arrives. Check
 * `GET /api/v3/config` → `rtmp.app` rather than assuming.
 */
export function ingestPushUrl(ingest: RtmpIngestConfig, ingestName: string): string {
  const app = (ingest.app || '').replace(/^\/+|\/+$/g, '');
  const path = app ? `${app}/${ingestName}` : ingestName;
  const base = `rtmp://${ingest.host}:${ingest.port}/${path}`;
  return ingest.token ? `${base}?token=${encodeURIComponent(ingest.token)}` : base;
}

/**
 * Build the datarhei Core process that fans one RTMP ingest out to a monitor
 * copy (always output[0]) plus every enabled destination — all stream-copied
 * (`-c copy`), so the split is CPU-cheap and lossless. Pure: no I/O, easy to
 * unit-test and to reuse verbatim in another app.
 */
export function buildSplitProcessConfig(spec: SplitSpec): CoreProcessConfig {
  const ingestName = ingestNameFor(spec);
  const copy = ['-c', 'copy', '-f', 'flv'];

  const output = [
    { id: 'monitor', address: spec.monitorUrl, options: copy },
    ...spec.destinations
      .filter((d) => d.enabled)
      .map((d) => ({
        id: `dest-${d.id}`.replace(/[^a-z0-9_-]+/gi, '-'),
        address: joinRtmp(d.url, d.streamKey),
        options: copy,
      })),
  ];

  return {
    id: processIdFor(spec.referencePrefix, spec.channelId),
    reference: `${spec.referencePrefix}:${spec.channelId}`,
    type: 'ffmpeg',
    autostart: true,
    reconnect: true,
    reconnect_delay_seconds: 5,
    stale_timeout_seconds: 30,
    options: ['-err_detect', 'ignore_err'],
    input: [{ id: 'in', address: `{rtmp,name=${ingestName}}`, options: [] }],
    output,
  };
}


export interface SplitManagerOptions {
  referencePrefix: string;
  ingest: RtmpIngestConfig;
  /** fetch used to reach a browser source's renderer; defaults to global fetch.
   *  Separate from the Core client's, because a mocked Core and a real renderer
   *  is a combination worth being able to express. */
  rendererFetch?: FetchLike;
}

/**
 * Stateless orchestrator over a RestreamerClient. A channel is up to two Core
 * processes and, for a browser source, a renderer told where to publish:
 *
 *   source ──▶ [feeder process]? ──▶ {rtmp,name=…} ──▶ [split process] ──▶ outputs
 *
 * The feeder exists only for source kinds the Core has to play itself; `rtmp`
 * and `browser` are fed from outside it. The split is identical either way, so
 * a channel's destinations neither know nor care what is feeding them.
 *
 * The host app owns where destinations and the source are stored; it just
 * passes the current values into `sync`.
 */
export class SplitManager {
  constructor(
    private client: RestreamerClient,
    private opts: SplitManagerOptions,
  ) {}

  processId(channelId: string): string {
    return processIdFor(this.opts.referencePrefix, channelId);
  }

  sourceProcessId(channelId: string): string {
    return sourceProcessIdFor(this.processId(channelId));
  }

  /** The URL whatever feeds this channel publishes to: an ATEM, or a renderer,
   *  or our own feeder process. */
  ingestPushUrl(channelId: string, source: ChannelSource = DEFAULT_SOURCE): string {
    return ingestPushUrl(
      this.opts.ingest,
      ingestNameFor({ channelId, source }),
    );
  }

  private rendererOutputName(channelId: string): string {
    return rendererOutputName(this.opts.referencePrefix, channelId);
  }

  /** Create the process if missing, otherwise replace its config; then ensure
   *  it's running. Returns the resulting channel state. */
  async sync(
    channelId: string,
    monitorUrl: string,
    destinations: Destination[],
    source: ChannelSource = DEFAULT_SOURCE,
  ): Promise<ChannelState> {
    const spec: SplitSpec = {
      referencePrefix: this.opts.referencePrefix,
      channelId,
      monitorUrl,
      destinations,
      source,
    };
    const config = buildSplitProcessConfig(spec);
    await this.upsert(config);

    // The feeder second, so the split is already subscribed when video starts.
    const feeder = buildSourceProcessConfig(spec, config.id);
    if (feeder) {
      await this.upsert(feeder);
    } else {
      // Switching a channel from `file` back to `rtmp`/`browser` has to remove
      // the old feeder, or it keeps publishing over whatever replaced it.
      await this.deleteProcess(this.sourceProcessId(channelId));
    }

    const renderer = createRenderer(source, this.opts.rendererFetch);
    if (source.kind === 'browser' && renderer) {
      await renderer.apply(source, this.ingestPushUrl(channelId, source), this.rendererOutputName(channelId));
    }

    return (
      (await this.state(channelId, destinations, monitorUrl, source)) ?? {
        channelId,
        processId: config.id,
        provisioned: true,
        running: true,
        ingestPushUrl: this.ingestPushUrl(channelId, source),
        monitorUrl,
        destinations,
        source,
      }
    );
  }

  private async upsert(config: CoreProcessConfig): Promise<void> {
    const existing = await this.client.tryGetProcess(config.id);
    if (existing) {
      await this.client.updateProcess(config.id, config);
      await this.client.command(config.id, 'restart').catch(() => undefined);
    } else {
      await this.client.createProcess(config);
    }
  }

  private async deleteProcess(id: string): Promise<void> {
    const existing = await this.client.tryGetProcess(id);
    if (!existing) return;
    await this.client.command(id, 'stop').catch(() => undefined);
    await this.client.deleteProcess(id);
  }

  private async sourceProcessState(
    channelId: string,
    source: ChannelSource,
  ): Promise<SourceProcessState | undefined> {
    if (!needsSourceProcess(source)) return undefined;
    const id = this.sourceProcessId(channelId);
    const proc = await this.client.tryGetProcess(id);
    if (!proc) return { processId: id, provisioned: false, running: false };
    return {
      processId: id,
      provisioned: true,
      running: proc.state?.exec === 'running',
      exec: proc.state?.exec,
      lastLog: proc.state?.last_logline,
    };
  }

  async state(
    channelId: string,
    destinations: Destination[],
    monitorUrl: string,
    source: ChannelSource = DEFAULT_SOURCE,
  ): Promise<ChannelState | null> {
    const id = this.processId(channelId);
    const proc = await this.client.tryGetProcess(id);
    const sourceProcess = await this.sourceProcessState(channelId, source);
    const renderer = createRenderer(source, this.opts.rendererFetch);
    const rendererState = renderer
      ? await renderer.state(this.rendererOutputName(channelId))
      : undefined;

    const base = {
      channelId,
      processId: id,
      ingestPushUrl: this.ingestPushUrl(channelId, source),
      monitorUrl,
      destinations,
      source,
      sourceProcess,
      renderer: rendererState,
    };

    if (!proc) return { ...base, provisioned: false, running: false };
    const exec = proc.state?.exec;
    return {
      ...base,
      provisioned: true,
      running: exec === 'running',
      exec,
      lastLog: proc.state?.last_logline,
    };
  }

  async teardown(channelId: string, source: ChannelSource = DEFAULT_SOURCE): Promise<void> {
    const renderer = createRenderer(source, this.opts.rendererFetch);
    if (renderer) await renderer.release(this.rendererOutputName(channelId));
    await this.deleteProcess(this.sourceProcessId(channelId));
    await this.deleteProcess(this.processId(channelId));
  }
}
