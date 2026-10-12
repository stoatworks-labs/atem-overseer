# Atem Overseer — Developing

Node/TypeScript, npm-workspaces monorepo. The [README](../README.md) has the architecture diagram
and the quick start; this is the workflow, the rules and the traps.

---

## 1. Where this sits

Three ATEM projects in this fleet, easy to confuse:

| Repo | Purpose |
|---|---|
| **atem-overseer** (this) | *Monitor and control* a fleet, live, from one dashboard |
| **atem-fleet-admin** | *Provision/configure* many switchers at once (XML export or live apply) |
| **animATEM** | *Control one* switcher, with UVC multiview compositing for SuperSource/DVE |

**Before adding a feature, check it belongs here** rather than in a sibling.

---

## 2. The working rule: develop against `--mock`

```bash
npm run dev:mock     # <- DEFAULT. Simulated ATEM fleet, no hardware.
npm run dev          # against real devices
```

**`dev:mock` is the intended development mode.** A whole simulated switcher fleet is built in, so
no hardware is needed, and the entire Phase 1 verification was done this way.

> **Verify every change against mock *before* pointing anything at real devices.** This isn't
> timidity — a fleet dashboard sends transport commands to switchers that may be live on air.
> There is no confirmation step in the UI and no undo on a stopped recording.

Note what `--mock` actually does, in `index.ts`:

```ts
const cfg = MOCK && fileCfg.devices.length === 0 ? mockConfig() : fileCfg;
new DeviceManager(cfg, MOCK, media.streamInfo)
```

Two separate effects: the flag makes every runner a simulator, **and** it substitutes the demo
fleet *only when the config file has no devices*. With a real config present you get **your own
device list, simulated**. Safe, but don't read familiar names as evidence of a real connection.

---

## 3. Monorepo layout and build order

```
packages/
  restreamer   @av/restreamer library — built FIRST (build:libs)
  server       @atem-overseer/server — backend
  web          @atem-overseer/web — frontend
launcher/      av-launcher desktop wrapper (Tauri v2)
```

> **`build:libs` must run before server or web.** The `dev`, `build` and `typecheck` scripts all
> do it automatically. **If you see phantom type errors, that's almost always the cause** — you
> ran a workspace script directly instead of the root one.

```bash
npm run dev:mock     # build:libs + server in mock mode
npm run dev          # build:libs + server against real devices
npm run dev:web      # web only
npm run build        # build:libs + web + server
npm run typecheck    # build:libs + both workspaces
npm start            # start the built server
```

CI: `.github/workflows/ci.yml`, plus `release.yml` and `release-desktop.yml`.

---

## 4. The shape of the server

```
packages/server/src/
  index.ts            wiring + lifecycle; owns the listen()
  api.ts              every REST route
  wsBridge.ts         WebSocket fan-out and command intake
  commands.ts         runCommand() — the ONE place a control command is applied
  types.ts            the normalized dashboard model
  config.ts           config file schema + mockConfig()
  discovery.ts        mDNS-style discovery
  externalApps.ts     per-platform desktop-app launching
  restreamerService.ts
  atem/manager.ts     per-device runners over atem-connection
  stream/mediaServer.ts   node-media-server: RTMP in → http-flv out
  stream/streamingXml.ts  Streaming.xml + atem-overseer.xml
```

Two invariants worth preserving:

- **`runCommand()` is shared by REST and WebSocket**, deliberately, so the two control paths
  cannot drift. Add commands there, not in a route handler.
- **`types.ts` is decoupled from `atem-connection`'s raw state on purpose** — the UI never has to
  know the wire protocol. Normalize in the runner, not in the browser.
  `packages/web/src/types.ts` holds **a hand-maintained copy**. Change one, change the other.

### Snapshot vs levels

The manager emits three events, fanned out differently:

| Event | Message | When |
|---|---|---|
| `snapshot` | `{ type: 'device' }` | one device's state changed |
| `fleet` | `{ type: 'snapshot' }` | a device was added or removed — full re-sync |
| `levels` | `{ type: 'levels' }` | **batched, far more frequent** than snapshots |

Audio levels are on their own channel for exactly that reason. Don't fold them into the snapshot
— a meter update rate applied to full snapshots would flood the socket.

---

## 5. Security posture — know it before you change it

> **The server binds to every interface and has no authentication.** `server.listen(cfg.httpPort)`
> is called without a host argument. Every transport command — start/stop recording, start/stop
> streaming — is available unauthenticated to anything that can reach port 4700.

That is the current, documented state ([USER-GUIDE.md §0](USER-GUIDE.md), [API.md](API.md)). If
you add anything that widens the surface — remote config write, file upload, process launch —
**you are adding it to an unauthenticated endpoint.** `/api/devices/:id/launch` already spawns a
process on the host, which is worth remembering before extending it.

If authentication is ever added, the WebSocket needs it too — it accepts control messages
independently of REST.

---

## 6. Error handling as it stands

- **Every thrown error becomes `400`**, via `asyncH`. "Unknown device" returns 400, not 404.
  Clients cannot distinguish a bad request from a missing device.
- **`action` is compared to the literal `'start'`** — anything else means stop, with no
  validation and no error.
- **A non-array `destinations` body is treated as empty**, silently clearing a device's egress
  destinations.
- **Malformed WebSocket JSON is dropped silently.**
- **Successful commands are never acknowledged.** Only failures produce a `toast`, and only to
  the originating client.

These are documented in [API.md](API.md) as current behaviour rather than defended as design.
If you tighten any of them, update that doc.

---

## 7. Status — be precise about it

Developed and verified end-to-end **against the built-in simulated fleet (`--mock`)**. It has
since been run against live ATEM hardware on two dates, 2026-07-17 and 2026-09-22
(`docs/NOTES.md` records what each one proved). Media upload still hasn't been tried on
hardware.

The README specifically calls out **transport, streaming and media-upload** behaviour as things
to validate against your own switchers first. Those are the paths where a simulator is least
likely to match reality — **don't let them be described as proven** in any new text.

---

## 8. Conventions

- Ships as its own desktop app via **[av-launcher](https://github.com/stoatworks-labs/av-launcher)**.
  Note the macOS Gatekeeper trap common to all av-launcher apps: for an unsigned `.app` bundling
  helper binaries, **approving the app does not unquarantine its payload** — helpers are
  SIGKILLed silently. See [`launcher/SIGNING.md`](../launcher/SIGNING.md).
- Multi-platform release CI; **cross-compile macOS x86_64 on `macos-14` — never `macos-13`.**
- Public repo, MIT. "Commit" means commit **and** push.
- Keep the AI-assistance disclaimer in user-facing text.

---

## See also

- [API.md](API.md) — REST, WebSocket, snapshot fields, config schema
- [USER-GUIDE.md](USER-GUIDE.md) — the operator view
- [device-management.md](device-management.md) · [streaming-setup.md](streaming-setup.md) · [restreamer.md](restreamer.md)
- [`AGENTS.md`](../AGENTS.md) — LLM onboarding
