import express, { type Express } from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeviceManager } from './atem/manager.js';
import { runCommand } from './commands.js';
import { loadConfig, saveConfig, type OverseerConfig } from './config.js';
import type { Discovery } from './discovery.js';
import type { ExternalApps } from './externalApps.js';
import type { RestreamerService } from './restreamerService.js';
import {
  generateConfigXml,
  generateStreamingXml,
  parseConfigXml,
  streamingServiceFor,
} from './stream/streamingXml.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

export interface ApiDeps {
  manager: DeviceManager;
  cfg: OverseerConfig;
  webDist: string;
  discovery: Discovery;
  externalApps: ExternalApps;
  restreamer: RestreamerService;
}

/**
 * The REST half of the server. The WebSocket half is wsBridge.ts; between them
 * they are the whole external surface.
 *
 * NO AUTHENTICATION, ANYWHERE. index.ts calls server.listen() with no host
 * argument, so this binds every interface — and the transport routes below
 * start and stop recording and streaming on switchers that may be live on air.
 * Anything that can reach the port can do that, with no token, session or TLS.
 * Adding a route here is adding it to an unauthenticated endpoint; adding one
 * that writes files or spawns processes doubly so.
 */
export function createApi({ manager, cfg, webDist, discovery, externalApps, restreamer }: ApiDeps): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '2mb' }));

  /**
   * Wrap an async handler so a rejection becomes a response instead of an
   * unhandled promise.
   *
   * Note it turns EVERY error into 400, including "unknown device" — which
   * would more naturally be a 404. A client therefore cannot tell a malformed
   * request from a missing device; both arrive as 400 with a message. That is
   * current behaviour rather than a considered design, and docs/API.md
   * documents it as such. If you split the statuses, update that doc.
   */

  /**
   * Express 5 types a path parameter as `string | string[]`, because
   * path-to-regexp v8 allows a pattern to repeat. None of the routes here
   * repeat -- every `:id` matches exactly one segment -- so the array case
   * cannot arise. Narrowed once here rather than cast at a dozen call sites.
   */
  const param = (req: express.Request, name: string): string => {
    const v = req.params[name];
    return Array.isArray(v) ? v[0] : v;
  };

  const asyncH =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response) =>
      fn(req, res).catch((err) => res.status(400).json({ error: (err as Error).message }));

  // ---- fleet + snapshots ----
  app.get('/api/config', (_req, res) => {
    res.json({
      devices: cfg.devices,
      publicHost: cfg.publicHost,
      rtmpPort: cfg.rtmpPort,
      mediaHttpPort: cfg.mediaHttpPort,
    });
  });

  app.get('/api/snapshot', (_req, res) => res.json({ devices: manager.snapshots() }));

  // ---- device management ----
  app.get('/api/discovery', (_req, res) => {
    res.json({ discovered: discovery.list(manager.managedAddresses()) });
  });

  app.post(
    '/api/devices',
    asyncH(async (req, res) => {
      const dc = await manager.addDevice({
        id: req.body.id,
        name: req.body.name,
        address: req.body.address,
      });
      res.json({ ok: true, device: dc });
    }),
  );

  app.delete(
    '/api/devices/:id',
    asyncH(async (req, res) => {
      await manager.removeDevice(param(req, 'id'));
      res.json({ ok: true });
    }),
  );

  app.get('/api/external-apps', (_req, res) => res.json({ apps: externalApps.list() }));

  /**
   * Launch a desktop app (ATEM Software Control and friends) with the device
   * pre-selected where the app supports it.
   *
   * It spawns the process on the SERVER's machine, not the browser's. If the
   * dashboard is open on a different computer, the app opens where nobody is
   * looking at it. Returns the launcher's own ok flag as 200/400 rather than
   * throwing.
   */
  app.post(
    '/api/devices/:id/launch',
    asyncH(async (req, res) => {
      const device = manager.config(param(req, 'id'));
      if (!device) throw new Error('unknown device');
      const result = externalApps.launch(String(req.body.app), device);
      res.status(result.ok ? 200 : 400).json({ ...result, address: device.address });
    }),
  );

  // ---- Restreamer split pipeline ----
  app.get(
    '/api/restreamer',
    asyncH(async (_req, res) => res.json(await restreamer.status())),
  );

  app.get('/api/restreamer/compose', (_req, res) => {
    res.setHeader('Content-Type', 'application/yaml');
    res.setHeader('Content-Disposition', 'attachment; filename="docker-compose.restreamer.yml"');
    res.send(restreamer.composeYaml());
  });

  app.get(
    '/api/devices/:id/restreamer',
    asyncH(async (req, res) => {
      if (!manager.config(param(req, 'id'))) throw new Error('unknown device');
      res.json(await restreamer.channel(param(req, 'id')));
    }),
  );

  app.post(
    '/api/devices/:id/restreamer/provision',
    asyncH(async (req, res) => {
      if (!manager.config(param(req, 'id'))) throw new Error('unknown device');
      res.json(await restreamer.provision(param(req, 'id')));
    }),
  );

  /**
   * Replace a device's egress destination list.
   *
   * A body whose `destinations` is not an array is treated as an empty array,
   * so a malformed request SILENTLY CLEARS every destination for that device
   * rather than erroring. Deliberate leniency, genuinely surprising outcome.
   */
  app.put(
    '/api/devices/:id/restreamer/destinations',
    asyncH(async (req, res) => {
      if (!manager.config(param(req, 'id'))) throw new Error('unknown device');
      const destinations = Array.isArray(req.body?.destinations) ? req.body.destinations : [];
      res.json(await restreamer.setDestinations(param(req, 'id'), destinations));
    }),
  );

  /**
   * Change what feeds a device's channel: the ATEM itself (`rtmp`), a file
   * played out by Restreamer (`file`), or a page rendered by WebLinked
   * (`browser`). Unlike the destinations route above this one is strict — an
   * unparseable body is a 400 that changes nothing, because provisioning a
   * channel from a half-understood source is how you put the wrong thing to
   * air. See docs/restreamer.md.
   */
  app.put(
    '/api/devices/:id/restreamer/source',
    asyncH(async (req, res) => {
      if (!manager.config(param(req, 'id'))) throw new Error('unknown device');
      res.json(await restreamer.setSource(param(req, 'id'), req.body?.source));
    }),
  );

  app.delete(
    '/api/devices/:id/restreamer',
    asyncH(async (req, res) => {
      await restreamer.teardown(param(req, 'id'));
      res.json({ ok: true });
    }),
  );

  // ---- transport / mode commands (REST twins of the WS commands) ----
  //
  // These four go through runCommand(), the same function wsBridge.ts calls, so
  // the REST and WebSocket control paths cannot drift apart. Add commands
  // there, not here.
  //
  // Note what runCommand does with `action`: it compares against the literal
  // 'start'. Anything else — a typo, a missing field, a boolean — means STOP,
  // with no validation and an {ok:true} response. So POSTing {"action":"begin"}
  // stops a recording and reports success.
  app.post(
    '/api/devices/:id/record',
    asyncH(async (req, res) => {
      await runCommand(manager, { type: 'record', id: param(req, 'id'), action: req.body.action });
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/devices/:id/stream',
    asyncH(async (req, res) => {
      await runCommand(manager, { type: 'stream', id: param(req, 'id'), action: req.body.action });
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/devices/:id/record-mode',
    asyncH(async (req, res) => {
      await runCommand(manager, { type: 'recordMode', id: param(req, 'id'), mode: req.body.mode });
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/devices/:id/monitor-mute',
    asyncH(async (req, res) => {
      await runCommand(manager, { type: 'monitorMute', id: param(req, 'id'), muted: !!req.body.muted });
      res.json({ ok: true });
    }),
  );

  // ---- streaming config: XML export + one-click apply to a device ----
  app.get('/api/streaming.xml', (_req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="Streaming.xml"');
    res.send(generateStreamingXml(cfg));
  });

  /**
   * Push the RTMP streaming config to a switcher over the protocol, as an
   * alternative to downloading Streaming.xml.
   *
   * Not every model supports it. A runner without setStreamingService throws
   * "device does not support remote streaming config" — a capability gap on the
   * switcher, not a fault here. Those models need the XML route.
   */
  app.post(
    '/api/devices/:id/streaming-service',
    asyncH(async (req, res) => {
      const runner = manager.get(param(req, 'id'));
      if (!runner) throw new Error('unknown device');
      if (!runner.setStreamingService) throw new Error('device does not support remote streaming config');
      await runner.setStreamingService(streamingServiceFor(cfg, param(req, 'id')));
      res.json({ ok: true });
    }),
  );

  // ---- Overseer config XML save / load ----
  app.get('/api/config.xml', (_req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="atem-overseer.xml"');
    res.send(generateConfigXml(cfg));
  });

  /**
   * Import an Overseer config XML: merged over the on-disk config and saved.
   *
   * DEVICE CHANGES DO NOT TAKE EFFECT UNTIL RESTART — the response says so in
   * its `note` field, and the dashboard keeps showing the old fleet until then.
   * This is Overseer's own fleet/ingest config, not an ATEM state backup;
   * restoring it restores nothing about the switchers themselves.
   */
  app.post(
    '/api/config.xml',
    asyncH(async (req, res) => {
      const xml = typeof req.body === 'string' ? req.body : req.body?.xml;
      if (!xml) throw new Error('expected XML body');
      const parsed = parseConfigXml(xml);
      const merged = { ...loadConfig(), ...parsed } as OverseerConfig;
      saveConfig(merged);
      res.json({ ok: true, devices: parsed.devices?.length ?? 0, note: 'saved; restart to apply device changes' });
    }),
  );

  // ---- media pool (behind the gear) ----
  app.get(
    '/api/devices/:id/media',
    asyncH(async (req, res) => {
      const runner = manager.get(param(req, 'id'));
      if (!runner) throw new Error('unknown device');
      res.json(runner.mediaPool());
    }),
  );

  app.post(
    '/api/devices/:id/media/assign',
    asyncH(async (req, res) => {
      const runner = manager.get(param(req, 'id'));
      if (!runner) throw new Error('unknown device');
      const { playerIndex, sourceType, slotIndex } = req.body;
      await runner.assignMediaPlayer(Number(playerIndex), sourceType, Number(slotIndex));
      res.json({ ok: true });
    }),
  );

  /**
   * Upload a still into the media pool.
   *
   * The payload is RAW RGBA, not PNG or JPEG — the browser decodes and scales
   * to the switcher's resolution before posting, and this passes the buffer
   * straight through. A client that posts an encoded image produces garbage in
   * the media pool rather than an error. 64 MB cap (see `upload` above).
   *
   * Media upload is one of the paths never exercised against real hardware;
   * see the README's caveats before relying on it.
   */
  app.post(
    '/api/devices/:id/media/still',
    upload.single('data'),
    asyncH(async (req, res) => {
      const runner = manager.get(param(req, 'id'));
      if (!runner) throw new Error('unknown device');
      if (!req.file) throw new Error('missing RGBA payload');
      const slotIndex = Number(req.body.slotIndex);
      const name = String(req.body.name || `still-${slotIndex}`);
      await runner.uploadStill(slotIndex, name, req.file.buffer);
      res.json({ ok: true });
    }),
  );

  // ---- static web ----
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .status(200)
        .send('Atem Overseer API is running. Build the web app (npm run build) or use the Vite dev server.'),
    );
  }

  return app;
}
