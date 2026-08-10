import type {
  BrowserSource,
  ChannelSource,
  FetchLike,
  RendererConfig,
  RendererState,
} from './types.js';

/**
 * What a browser source needs from whatever is turning a page into video. Kept
 * as an interface because the Core has no browser and never will — the renderer
 * is always a separate process, and which one it is should not reach into the
 * split logic.
 */
export interface BrowserRenderer {
  /** Point the renderer at the page and have it publish to `publishUrl`. */
  apply(source: BrowserSource, publishUrl: string, outputName: string): Promise<void>;
  /** Stop publishing. The page stays loaded — tearing a channel down should not
   *  black out a renderer that other channels may share. */
  release(outputName: string): Promise<void>;
  state(outputName: string): Promise<RendererState>;
}

/** Output name for a channel, namespaced so two apps can share one renderer. */
export function rendererOutputName(referencePrefix: string, channelId: string): string {
  return `${referencePrefix}-${channelId}`;
}

/**
 * A video format string WebLinked's parser accepts: `1920x1080p50`. The rate is
 * passed through verbatim so an exact rational (`60000/1001`) survives — a
 * decimal `59.94` is a different rate and drifts about 40 ms a minute.
 */
export function rendererFormat(source: BrowserSource): string | null {
  const { width, height, frameRate } = source;
  if (!width || !height) return null;
  return `${width}x${height}p${frameRate || '50'}`;
}

interface WebLinkedOutput {
  kind?: string;
  name?: string;
  running?: boolean;
  enabled?: boolean;
  error?: string;
  options?: Record<string, unknown>;
}

interface WebLinkedState {
  outputs?: WebLinkedOutput[];
  source?: { url?: string; loaded_url?: string };
  compiled_backends?: string[];
}

/**
 * Client for WebLinked's control API (`docs/03-control-api.md` in that repo),
 * driving one of its pipelines to render a page and publish it as RTMP.
 *
 * WebLinked is the fleet's URL-to-broadcast-video renderer; this treats it as
 * one implementation of `BrowserRenderer`, not as the only possible one.
 */
export class WebLinkedRenderer implements BrowserRenderer {
  private base: string;
  private fetch: FetchLike;

  constructor(
    private cfg: RendererConfig,
    fetchImpl?: FetchLike,
  ) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private url(path: string): string {
    const params: string[] = [];
    if (this.cfg.sourceId) params.push(`source=${encodeURIComponent(this.cfg.sourceId)}`);
    return params.length ? `${this.base}${path}?${params.join('&')}` : `${this.base}${path}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    return {
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`renderer POST ${path} -> ${res.status} ${text}`.trim());
    }
  }

  private async getState(): Promise<WebLinkedState> {
    const res = await this.fetch(this.url('/api/state'), {
      method: 'GET',
      headers: this.headers(false),
    });
    if (!res.ok) throw new Error(`renderer GET /api/state -> ${res.status}`);
    return (await res.json()) as WebLinkedState;
  }

  private streamOutput(source: BrowserSource, publishUrl: string, outputName: string) {
    return {
      kind: 'stream',
      name: outputName,
      options: {
        url: publishUrl,
        ...(source.videoBitrate ? { bitrate: source.videoBitrate } : {}),
      },
    };
  }

  async apply(source: BrowserSource, publishUrl: string, outputName: string): Promise<void> {
    // Order matters: a format change restarts every output, so setting it after
    // the stream output exists would bounce the feed we just started.
    const format = rendererFormat(source);
    if (format) await this.post('/api/format', { format });
    await this.post('/api/url', { url: source.url });

    const state = await this.getState();
    const existing = (state.outputs ?? []).some((o) => o.name === outputName);
    const output = this.streamOutput(source, publishUrl, outputName);
    if (existing) {
      await this.post('/api/output/update', { name: outputName, output });
    } else {
      await this.post('/api/output/add', output);
    }
  }

  async release(outputName: string): Promise<void> {
    await this.post('/api/output/remove', { name: outputName }).catch(() => undefined);
  }

  async state(outputName: string): Promise<RendererState> {
    try {
      const state = await this.getState();
      const output = (state.outputs ?? []).find((o) => o.name === outputName);
      return {
        reachable: true,
        loadedUrl: state.source?.loaded_url ?? state.source?.url,
        publishing: !!output?.running,
        error: output?.error,
      };
    } catch (err) {
      return { reachable: false, error: (err as Error).message };
    }
  }
}

/**
 * Build the renderer a browser source names, or null for any other source kind
 * and for a browser source that names none — a channel is allowed to be
 * provisioned with nobody yet told to render it.
 */
export function createRenderer(source: ChannelSource, fetchImpl?: FetchLike): BrowserRenderer | null {
  if (source.kind !== 'browser' || !source.renderer?.url) return null;
  return new WebLinkedRenderer(source.renderer, fetchImpl);
}
