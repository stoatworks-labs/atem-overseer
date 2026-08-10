# Atem Overseer — API

The server exposes a REST API, a WebSocket channel, two XML documents and a JSON config file.

| § | Interface | Source |
|---|---|---|
| [1](#1-rest-api) | REST API | `packages/server/src/api.ts` |
| [2](#2-websocket-ws) | WebSocket `/ws` | `packages/server/src/wsBridge.ts`, `types.ts` |
| [3](#3-the-device-snapshot) | The device snapshot | `packages/server/src/types.ts` |
| [4](#4-config-file) | `atem-overseer.config.json` | `packages/server/src/config.ts` |
| [5](#5-xml-documents) | Streaming.xml / atem-overseer.xml | `packages/server/src/stream/streamingXml.ts` |
| [6](#6-ports) | Ports | `README` |

> **⚠ There is no authentication on any of this, and the server binds to every interface.**
> `server.listen(cfg.httpPort)` is called without a host, so the dashboard, the REST API and the
> WebSocket are reachable from anywhere that can route to the machine. Every transport command —
> **start/stop recording, start/stop streaming** — is available unauthenticated to anyone who can
> reach port 4700, on switchers that may be live on air. There is no token, no session and no
> TLS. Run it on a private production network only.

> **Verified against the built-in `--mock` fleet, not live hardware.** Transport, streaming and
> media-upload are the paths a simulator is least likely to match — validate those against your
> own switcher models before relying on them.

---

## 1. REST API

Errors are `400 {"error": "..."}` — the async wrapper turns **every** thrown error into a 400,
including "unknown device", which would more naturally be a 404. There is no other error status.

### Fleet and state

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/config` | `{ devices, publicHost, rtmpPort, mediaHttpPort }` |
| `GET` | `/api/snapshot` | `{ devices: DeviceSnapshot[] }` (§3) |
| `GET` | `/api/discovery` | `{ discovered: DiscoveredDevice[] }` — already-managed addresses are flagged, not hidden |

### Device management

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/api/devices` | `{ id, name, address }` | adds and connects immediately |
| `DELETE` | `/api/devices/:id` | — | disconnects and removes |
| `GET` | `/api/external-apps` | — | `{ apps: ExternalAppInfo[] }` |
| `POST` | `/api/devices/:id/launch` | `{ app }` | launches a desktop app **on the server's machine** |

> **`/launch` runs a process on the host running the server, not on the browser's machine.** If
> the dashboard is open on a different computer than the server, the app opens where the server
> is. It returns `200`/`400` from the launcher's own `ok` flag rather than throwing.

### Transport and mode

These are the REST twins of the WebSocket commands — both call the same `runCommand()`, so they
cannot drift.

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/devices/:id/record` | `{ action: 'start' \| 'stop' }` |
| `POST` | `/api/devices/:id/stream` | `{ action: 'start' \| 'stop' }` |
| `POST` | `/api/devices/:id/record-mode` | `{ mode: 'pgm' \| 'iso' }` |
| `POST` | `/api/devices/:id/monitor-mute` | `{ muted: boolean }` |

**`action` is compared to the literal `'start'`.** Anything else — a typo, a missing field, `true`
— means **stop**. There is no validation and no error; `{"action":"begin"}` stops the recording
and returns `{"ok":true}`.

`monitor-mute` mutes the **ATEM's monitor bus**, not the browser's playback. The per-tile mute in
the UI is separate client state and never touches the switcher (§3).

### Streaming config

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/streaming.xml` | downloads `Streaming.xml` for ATEM Software Control |
| `POST` | `/api/devices/:id/streaming-service` | pushes the RTMP config directly over the protocol |

**The direct push is model-dependent.** If the runner has no `setStreamingService`, it throws
`device does not support remote streaming config` — that's a capability gap on the switcher, not
a fault. Use the XML route for those.

### Overseer config XML

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/config.xml` | downloads `atem-overseer.xml` |
| `POST` | `/api/config.xml` | accepts raw XML (`application/xml`/`text/xml`) or `{ xml }` |

**Importing merges over the on-disk config and saves it, but does not apply device changes
live.** The response says so: `{ ok: true, devices: n, note: 'saved; restart to apply device
changes' }`. A fleet imported this way is inert until restart.

This is **Overseer's own fleet/ingest config**, not an ATEM state backup — it doesn't capture
anything about the switchers themselves.

### Media pool

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/devices/:id/media` | — → `MediaPool` |
| `POST` | `/api/devices/:id/media/assign` | `{ playerIndex, sourceType, slotIndex }` |
| `POST` | `/api/devices/:id/media/still` | multipart `data` = **raw RGBA**, plus `slotIndex`, `name` |

**Stills upload as raw RGBA, not PNG/JPEG.** The browser converts and scales to the switcher's
resolution before posting; the server passes the buffer straight through. A client that posts an
encoded image will produce garbage in the media pool, not an error.

Upload limit **64 MB** (multer), JSON body limit 2 MB, XML body limit 2 MB. `name` defaults to
`still-<slotIndex>`.

### Restreamer (optional split pipeline)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/restreamer` | overall status |
| `GET` | `/api/restreamer/compose` | downloads `docker-compose.restreamer.yml` |
| `GET` | `/api/devices/:id/restreamer` | that device's channel |
| `POST` | `/api/devices/:id/restreamer/provision` | create the channel |
| `PUT` | `/api/devices/:id/restreamer/destinations` | `{ destinations: [...] }` |
| `PUT` | `/api/devices/:id/restreamer/source` | `{ source: { kind: "rtmp" \| "file" \| "browser", ... } }` |
| `DELETE` | `/api/devices/:id/restreamer` | tear the channel down |

`destinations` **must be an array or it is treated as empty** — a malformed body silently clears
every egress destination for that device rather than erroring. See
[restreamer.md](restreamer.md).

`source` is the opposite: it is **validated strictly**, and an unparseable body is a 400 that
changes nothing. A file source with no `path`, a browser source with no `url`, a decimal
`frameRate` and an unknown `kind` are all rejected by name. Changing the source of a channel
that is already provisioned re-syncs it live; changing it on a torn-down channel does not
start anything.

### Static web

If `packages/web/dist` exists it is served, with `GET *` falling back to `index.html` (SPA
routing). If it doesn't, `/` returns a plain-text note that the API is running and the web app
needs building.

---

## 2. WebSocket `/ws`

Same origin and port as the REST API.

**On connect the server immediately sends a full `snapshot`**, so a client can render without
querying anything.

### Server → client

```ts
{ type: 'snapshot', devices: DeviceSnapshot[] }   // full re-sync
{ type: 'device',   device: DeviceSnapshot }      // one device changed
{ type: 'levels',   levels: { id, audio }[] }     // batched, far more frequent
{ type: 'toast',    level: 'info'|'error', text: string }
```

`snapshot` is re-broadcast on any **fleet** change (a device added or removed), not on state
changes — those come as `device`. **Levels are on their own channel and batched**, because they
arrive far more often than snapshots; don't treat a `levels` packet as a state update.

### Client → server

```ts
{ type: 'record',      id, action: 'start'|'stop' }
{ type: 'stream',      id, action: 'start'|'stop' }
{ type: 'recordMode',  id, mode: 'pgm'|'iso' }
{ type: 'monitorMute', id, muted: boolean }
```

- **Malformed JSON is dropped silently.**
- **A failed command replies with a `toast`** — addressed to that client only, not broadcast.
  That toast is the *only* acknowledgement; a **successful command produces no reply at all**.
  Confirmation comes from the next `device` snapshot.
- An unknown `id` throws `unknown device: <id>` and surfaces as a toast.

`packages/web/src/types.ts` holds **a copy** of these types. Keep them in sync by hand.

---

## 3. The device snapshot

The normalized dashboard model, **deliberately decoupled from `atem-connection`'s raw state** so
the UI never has to know the wire protocol.

```ts
{ id, name, address, model, connection: 'connecting'|'connected'|'disconnected',
  record: { status: 'idle'|'recording'|'stopping', mode: 'pgm'|'iso',
            duration: string|null, filename, timeAvailable },
  stream: { status: 'idle'|'connecting'|'streaming'|'stopping', duration: string|null,
            bitrate, cacheUsed, serviceName, flvUrl: string|null, live: boolean },
  disks: DiskInfo[], hostname: string|null, protocolVersion,
  audio: { leftLevel, rightLevel, leftPeak, rightPeak },
  monitorMuted, mediaPlayers: MediaPlayerAssignment[], lastUpdate }
```

Fields whose meaning is easy to assume wrongly:

- **`timeAvailable` is seconds of recording headroom, not bytes.** The ATEM protocol does not
  expose disk capacity at all. The UI's "drive capacity" bar uses **4 hours as a nominal
  full-scale reference** — it is not a percentage of a real disk.
- **`protocolVersion` is the ATEM protocol/API version, not the switcher's firmware version.**
  Firmware isn't exposed over the wire.
- **`monitorMuted` is the ATEM monitor bus.** The per-tile mute in the browser is separate client
  state that only silences local playback — it never affects the meter or the switcher.
- **Metering is telemetry and is always shown**, regardless of any mute.
- **`cacheUsed` is 0..1**, the fraction of the stream cache buffer in use — a network-health
  indicator, not a percentage complete.
- **`audio` levels are dBFS**, −100 (silence) to 0 (full scale).
- **`flvUrl` is only non-null while a stream is actually being ingested.**
- `duration` is a `HH:MM:SS.ff` **string**, or `null` when idle.
- `hostname` is reverse-DNS and often `null`.

---

## 4. Config file

`atem-overseer.config.json` in the working directory (see
`atem-overseer.config.example.json`).

```ts
{ devices: [{ id, name, address }],
  publicHost: string,      // what the ATEMs and browsers reach this machine at
  rtmpPort: number,
  mediaHttpPort: number,
  httpPort: number,
  externalApps?: Record<string, ExternalAppOverride>,
  restreamer?: RestreamerSettings }
```

**`publicHost` is load-bearing.** It's baked into the generated `Streaming.xml` and into the
http-flv playback URLs. Set to `localhost` or an unreachable address, the switchers won't find
the ingest and the browser won't find the playback — with no error saying so.

**`externalApps` overrides are per-platform argv arrays** (`darwin`/`win32`/`linux`), with
`{ip}`, `{host}` and `{name}` placeholders. See [device-management.md](device-management.md).

**`restreamer.channels` is keyed by device id.** Note the config holds a Restreamer
`username`/`password` **in plaintext** — the file needs the same protection as any credential
store.

### `--mock`

`npm run dev:mock` passes `--mock`, which does **two separate things**:

1. It makes every device runner a simulator, so nothing connects to real hardware.
2. It substitutes a simulated 3-switcher fleet **only if the config file has no devices**
   (`MOCK && fileCfg.devices.length === 0`).

So with a real config present, `--mock` still uses **your device list** — simulated, but with
your ids and names. That's usually what you want; just don't read the device list on screen as
evidence you're talking to hardware.

---

## 5. XML documents

**`Streaming.xml`** — generated for ATEM Software Control's streaming support folder. It declares
Overseer as a streaming service pointing at `rtmp://<publicHost>:<rtmpPort>/live/`. **The
switcher's stream key must be set to its Overseer device id** — that's how the ingest routes a
feed to the right tile. The device ids are listed in the XML.

**`atem-overseer.xml`** — Overseer's own config, exported and importable. Not an ATEM state
backup. Import saves but does not apply device changes until restart (§1).

---

## 6. Ports

| Port | Purpose |
|---|---|
| 4700 | Dashboard + REST + WebSocket |
| 1935 | RTMP ingest — `rtmp://<publicHost>:1935/live/<deviceId>` |
| 8000 | http-flv playback — `http://<publicHost>:8000/live/<deviceId>.flv` |

All configurable (`httpPort`, `rtmpPort`, `mediaHttpPort`).

---

## See also

- [USER-GUIDE.md](USER-GUIDE.md) — running it
- [DEVELOPING.md](DEVELOPING.md) — the monorepo, mock-first workflow
- [device-management.md](device-management.md) · [streaming-setup.md](streaming-setup.md) · [restreamer.md](restreamer.md)
