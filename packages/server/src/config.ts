import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChannelSource, RendererConfig } from '@av/restreamer';
import { log } from './diag/index.js';

export interface DeviceConfig {
  id: string;
  name: string;
  address: string;
}

/** Per-platform launch override for an external app. Each value is an argv
 *  array ([command, ...args]) with {ip} {host} {name} placeholders. */
export interface ExternalAppOverride {
  label?: string;
  autoSelect?: boolean;
  darwin?: string[];
  win32?: string[];
  linux?: string[];
}

export interface RestreamerDestination {
  id: string;
  name: string;
  url: string;
  streamKey?: string;
  enabled: boolean;
}

/**
 * Optional Restreamer (datarhei Core) integration. When enabled, ATEMs stream to
 * the Restreamer instead of directly to Overseer; Restreamer fans the feed out to
 * an automatic monitor copy back into Overseer's ingest, plus any egress
 * destinations. See docs/restreamer.md.
 */
export interface RestreamerSettings {
  enabled: boolean;
  /** base URL of the Restreamer / datarhei Core, e.g. http://restreamer.local:8080 */
  url: string;
  username: string;
  password: string;
  /** how the ATEM reaches the Restreamer's RTMP ingest */
  rtmpHost: string;
  rtmpPort: number;
  /** must match the Core's own `rtmp.app`; stock Restreamer is "/", so "" */
  rtmpApp: string;
  rtmpToken?: string;
  /** namespacing prefix for our processes on a shared Restreamer */
  referencePrefix: string;
  /**
   * Per-device channel settings, keyed by device id: the egress destinations,
   * and what feeds the channel. `source` defaults to `{ kind: 'rtmp' }` — the
   * ATEM publishing to Restreamer itself — so a config written before source
   * types existed keeps its exact previous behaviour.
   */
  channels?: Record<string, { destinations: RestreamerDestination[]; source?: ChannelSource }>;
  /**
   * Default renderer for browser sources that don't name their own, so a fleet
   * with one WebLinked doesn't repeat its address per device.
   */
  renderer?: RendererConfig;
}

export interface OverseerConfig {
  /** ATEM switchers to monitor */
  devices: DeviceConfig[];
  /** host the ATEMs (and browsers) should reach this machine at, for the stream ingest */
  publicHost: string;
  rtmpPort: number;
  mediaHttpPort: number;
  httpPort: number;
  /** optional overrides for the external-app launch buttons, keyed by app id */
  externalApps?: Record<string, ExternalAppOverride>;
  /** optional Restreamer split-pipeline integration */
  restreamer?: RestreamerSettings;
}

const DEFAULTS: OverseerConfig = {
  devices: [],
  publicHost: 'localhost',
  rtmpPort: 1935,
  mediaHttpPort: 8000,
  httpPort: 4700,
};

export function configPath(): string {
  return resolve(process.env.ATEM_OVERSEER_CONFIG || 'atem-overseer.config.json');
}

/**
 * A "mock" fleet used by `--mock` so the dashboard can be exercised end-to-end
 * without any ATEM hardware on the network.
 */
export function mockConfig(): OverseerConfig {
  // applyEnv here too: --mock bypasses loadConfig entirely, so without this
  // ATEM_OVERSEER_PORT/HOST are silently ignored in exactly the mode people
  // develop and record demos in, and the server binds the default port anyway.
  return applyEnv({
    ...DEFAULTS,
    devices: [
      { id: 'cam-a', name: 'Main Stage', address: '10.0.0.11' },
      { id: 'cam-b', name: 'Overflow Room', address: '10.0.0.12' },
      { id: 'cam-c', name: 'Foyer / B-Roll', address: '10.0.0.13' },
    ],
    restreamer: {
      enabled: true,
      url: 'http://restreamer.local:8080',
      username: 'admin',
      password: 'demo',
      rtmpHost: 'restreamer.local',
      rtmpPort: 1935,
      rtmpApp: '',
      referencePrefix: 'atem-overseer',
      renderer: { url: 'http://weblinked.local:7654' },
      channels: {
        // One channel of each source kind, so `--mock` exercises all three
        // paths rather than only the one that existed first.
        'cam-a': {
          destinations: [
            {
              id: 'yt',
              name: 'YouTube Live',
              url: 'rtmp://a.rtmp.youtube.com/live2',
              streamKey: 'demo-key',
              enabled: true,
            },
          ],
        },
        'cam-b': {
          destinations: [],
          source: {
            kind: 'browser',
            url: 'https://example.com/lower-third',
            width: 1920,
            height: 1080,
            frameRate: '50',
            videoBitrate: '6000k',
          },
        },
        'cam-c': {
          destinations: [],
          source: { kind: 'file', path: 'media/holding-slate.mp4', loop: true, silentAudio: true },
        },
      },
    },
  });
}

/** env overrides let the av-launcher inject host/port without touching the file */
function applyEnv(cfg: OverseerConfig): OverseerConfig {
  const port = process.env.ATEM_OVERSEER_PORT;
  const host = process.env.ATEM_OVERSEER_HOST;
  if (port && Number.isFinite(Number(port))) cfg.httpPort = Number(port);
  if (host) cfg.publicHost = host;
  return cfg;
}

export function loadConfig(): OverseerConfig {
  const path = configPath();
  if (!existsSync(path)) return applyEnv({ ...DEFAULTS });
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return applyEnv({ ...DEFAULTS, ...raw, devices: raw.devices ?? [] });
  } catch (err) {
    log.error({ path, err: (err as Error).message }, 'failed to read config');
    return applyEnv({ ...DEFAULTS });
  }
}

export function saveConfig(cfg: OverseerConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
