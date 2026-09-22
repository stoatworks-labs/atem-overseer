import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApi } from './api.js';
import { DeviceManager } from './atem/manager.js';
import { MediaServer } from './stream/mediaServer.js';
import { Discovery } from './discovery.js';
import { ExternalApps } from './externalApps.js';
import { RestreamerService } from './restreamerService.js';
import { loadConfig, mockConfig, type OverseerConfig } from './config.js';
import { collectDiagnostics, init as initDiag, log, setConfig } from './diag/index.js';

const MOCK = process.argv.includes('--mock');
const COLLECT_DIAGNOSTICS = process.argv.includes('--collect-diagnostics');

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(__dirname, '../../web/dist');

/**
 * npm_package_version is only set when the server is started through npm, which
 * the packaged app does not do — it spawns node on dist/index.js directly. Read
 * the manifest that ships beside dist/ so crash reports name the real version.
 */
function appVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  // Before anything that can fail — including reading the config file — so a
  // failure during startup is logged and captured like any other.
  initDiag({
    app: 'atem-overseer',
    envPrefix: 'ATEM_OVERSEER',
    version: appVersion(),
    cwd: resolve(__dirname, '../../..'),
  });

  const fileCfg = loadConfig();
  const cfg: OverseerConfig = MOCK && fileCfg.devices.length === 0 ? mockConfig() : fileCfg;
  setConfig(cfg);

  if (COLLECT_DIAGNOSTICS) {
    // stdout, so it can be used in a script; everything else went to stderr.
    console.log(collectDiagnostics());
    return;
  }

  const media = new MediaServer(cfg);
  const manager = new DeviceManager(cfg, MOCK, media.streamInfo);
  const discovery = new Discovery(MOCK);
  const externalApps = new ExternalApps(cfg);
  const restreamer = new RestreamerService(cfg, MOCK);

  // when a switcher starts/stops publishing to the RTMP ingest, refresh its tile
  media.on('liveChanged', (id: string) => {
    const runner = manager.get(id);
    if (runner) manager.emit('snapshot', runner.snapshot());
  });

  media.start();
  discovery.start();
  await manager.start();

  const app = createApi({ manager, cfg, webDist, discovery, externalApps, restreamer });
  const server = createServer(app);
  const { attachWebSocket } = await import('./wsBridge.js');
  attachWebSocket(server, manager);

  server.listen(cfg.httpPort, () => {
    const mode = MOCK ? ' [MOCK]' : '';
    // The banner stays a banner: it is an operator-facing summary at startup,
    // and boxing it into log lines would make it harder to read, not easier.
    // The same facts go to the log below, where a tool can find them.
    process.stderr.write(
      `\n  Atem Overseer${mode}\n` +
        `  ├─ dashboard   http://localhost:${cfg.httpPort}\n` +
        `  ├─ rtmp ingest rtmp://${cfg.publicHost}:${cfg.rtmpPort}/live/<deviceId>\n` +
        `  ├─ http-flv    http://${cfg.publicHost}:${cfg.mediaHttpPort}/live/<deviceId>.flv\n` +
        `  └─ devices     ${cfg.devices.map((d) => d.id).join(', ') || '(none configured)'}\n\n`,
    );
    log.info(
      {
        mock: MOCK,
        httpPort: cfg.httpPort,
        rtmpPort: cfg.rtmpPort,
        mediaHttpPort: cfg.mediaHttpPort,
        devices: cfg.devices.map((d) => d.id),
      },
      'listening',
    );
  });

  const shutdown = async () => {
    log.info('shutting down');
    await manager.stop();
    discovery.stop();
    media.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // Startup failures are fatal and worth a crash report, so re-raise rather
  // than swallowing: the uncaughtException handler writes the report.
  setImmediate(() => {
    throw err;
  });
});
