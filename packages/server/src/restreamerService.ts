import {
  DEFAULT_SOURCE,
  RestreamerClient,
  SplitManager,
  createMockRendererTransport,
  createMockTransport,
  parseChannelSource,
  type ChannelSource,
  type ChannelState,
  type Destination,
} from '@av/restreamer';
import { saveConfig, type OverseerConfig, type RestreamerDestination } from './config.js';
import { log } from './diag/index.js';

export interface RestreamerStatus {
  enabled: boolean;
  configured: boolean;
  url?: string;
  reachable?: boolean;
  referencePrefix?: string;
  /** source kinds this build can provision, for the UI to offer */
  sourceKinds?: ChannelSource['kind'][];
  /** the fleet-wide renderer, when one is configured */
  rendererUrl?: string;
}

/**
 * Overseer's glue around the portable @av/restreamer package. Owns the
 * configured instance, maps a device id to its split channel, and persists the
 * per-device egress destinations in the Overseer config. The monitor copy is
 * always pushed back to Overseer's own node-media-server ingest, so the tile
 * preview keeps working exactly as before — Restreamer just sits in front and
 * adds the internet fan-out.
 */
export class RestreamerService {
  private manager?: SplitManager;
  private client?: RestreamerClient;

  constructor(
    private cfg: OverseerConfig,
    private mock: boolean,
  ) {
    const r = cfg.restreamer;
    if (!r?.enabled) return;
    this.client = new RestreamerClient({
      url: r.url,
      username: r.username,
      password: r.password,
      fetch: mock ? createMockTransport() : undefined,
    });
    this.manager = new SplitManager(this.client, {
      referencePrefix: r.referencePrefix || 'atem-overseer',
      // No `|| 'live'` fallback: a stock Restreamer's rtmp.app is "/", so an
      // empty app is both valid and the common case. Defaulting to "live" sent
      // encoders to a path the split never reads — see docs/restreamer.md.
      ingest: { host: r.rtmpHost, port: r.rtmpPort, app: r.rtmpApp ?? '', token: r.rtmpToken },
      // In --mock there is no WebLinked either, so the browser path gets a
      // simulated renderer rather than silently failing every request.
      rendererFetch: mock ? createMockRendererTransport() : undefined,
    });
  }

  get enabled(): boolean {
    return !!this.manager;
  }

  /** where Restreamer pushes the automatic monitor copy: Overseer's own ingest */
  monitorUrl(deviceId: string): string {
    return `rtmp://${this.cfg.publicHost}:${this.cfg.rtmpPort}/live/${deviceId}`;
  }

  ingestPushUrl(deviceId: string): string | null {
    return this.manager ? this.manager.ingestPushUrl(deviceId) : null;
  }

  private destinations(deviceId: string): Destination[] {
    return (this.cfg.restreamer?.channels?.[deviceId]?.destinations ?? []) as Destination[];
  }

  /**
   * What feeds a device's channel. A browser source with no renderer of its own
   * inherits the fleet-wide one, so a single WebLinked doesn't have to be
   * repeated against every device.
   */
  source(deviceId: string): ChannelSource {
    const stored = this.cfg.restreamer?.channels?.[deviceId]?.source;
    if (!stored) return DEFAULT_SOURCE;
    if (stored.kind === 'browser' && !stored.renderer && this.cfg.restreamer?.renderer) {
      return { ...stored, renderer: this.cfg.restreamer.renderer };
    }
    return stored;
  }

  async status(): Promise<RestreamerStatus> {
    const r = this.cfg.restreamer;
    if (!r?.enabled || !this.client) return { enabled: false, configured: !!r };
    return {
      enabled: true,
      configured: true,
      url: r.url,
      referencePrefix: r.referencePrefix,
      sourceKinds: ['rtmp', 'file', 'browser'],
      rendererUrl: r.renderer?.url,
      reachable: await this.client.ping().catch(() => false),
    };
  }

  async channel(deviceId: string): Promise<ChannelState | null> {
    if (!this.manager) return null;
    return this.manager.state(
      deviceId,
      this.destinations(deviceId),
      this.monitorUrl(deviceId),
      this.source(deviceId),
    );
  }

  async provision(deviceId: string): Promise<ChannelState> {
    if (!this.manager) throw new Error('Restreamer is not enabled');
    return this.manager.sync(
      deviceId,
      this.monitorUrl(deviceId),
      this.destinations(deviceId),
      this.source(deviceId),
    );
  }

  /**
   * Change what feeds a device's channel, and re-provision if it was already
   * live. Validation happens in the package's `parseChannelSource`, so a bad
   * body is a 400 that changes nothing rather than a channel provisioned from
   * half-understood input.
   */
  async setSource(deviceId: string, input: unknown): Promise<ChannelState | null> {
    if (!this.cfg.restreamer) throw new Error('Restreamer is not enabled');
    const source = parseChannelSource(input);
    this.cfg.restreamer.channels ??= {};
    const channel = (this.cfg.restreamer.channels[deviceId] ??= { destinations: [] });
    channel.source = source;
    this.persist();
    if (!this.manager) return null;
    const existing = await this.manager.state(
      deviceId,
      this.destinations(deviceId),
      this.monitorUrl(deviceId),
      source,
    );
    // Only push it live if the channel was already provisioned; changing the
    // source of a torn-down channel should not quietly start streaming.
    if (existing?.provisioned) return this.provision(deviceId);
    return existing;
  }

  async setDestinations(deviceId: string, destinations: RestreamerDestination[]): Promise<ChannelState | null> {
    if (!this.cfg.restreamer) throw new Error('Restreamer is not enabled');
    this.cfg.restreamer.channels ??= {};
    const channel = (this.cfg.restreamer.channels[deviceId] ??= { destinations: [] });
    channel.destinations = destinations;
    this.persist();
    // if the channel is already provisioned, push the new output set live
    if (this.manager) {
      const existing = await this.manager.state(
        deviceId,
        destinations as Destination[],
        this.monitorUrl(deviceId),
        this.source(deviceId),
      );
      if (existing?.provisioned) return this.provision(deviceId);
      return existing;
    }
    return null;
  }

  async teardown(deviceId: string): Promise<void> {
    if (!this.manager) return;
    await this.manager.teardown(deviceId, this.source(deviceId));
  }

  private persist(): void {
    if (this.mock) return;
    try {
      saveConfig(this.cfg);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'restreamer config save failed');
    }
  }

  /** A ready-to-run docker-compose.yml for those who don't have a Restreamer yet. */
  composeYaml(): string {
    const r = this.cfg.restreamer;
    const user = r?.username || 'admin';
    const pass = r?.password || 'change-me';
    return `# Restreamer for Atem Overseer's split pipeline.
# Run:  docker compose up -d   then open http://localhost:8080 (admin login below).
# Point Overseer's config \`restreamer.url\` at http://<this-host>:8080 and set the
# same username/password. ATEMs publish to rtmp://<this-host>:1935/<deviceId> —
# note no app segment, because this image's rtmp.app is "/". Set \`rtmpApp\` to
# match whatever \`GET /api/v3/config\` reports, not to a guess.
services:
  restreamer:
    image: datarhei/restreamer:latest
    container_name: restreamer
    restart: unless-stopped
    ports:
      - "8080:8080"   # web UI + Core API
      - "1935:1935"   # RTMP ingest
      - "1936:1936"   # RTMPS
      - "6000:6000/udp" # SRT
    environment:
      - CORE_API_AUTH_USERNAME=${user}
      - CORE_API_AUTH_PASSWORD=${pass}
      - CORE_RTMP_ENABLE=true
    volumes:
      - restreamer-config:/core/config
      - restreamer-data:/core/data
volumes:
  restreamer-config:
  restreamer-data:
`;
  }
}
