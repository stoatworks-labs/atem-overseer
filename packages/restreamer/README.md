# @av/restreamer

A small, **framework-agnostic** client for [datarhei Core](https://docs.datarhei.com/core)
(the engine behind [Restreamer](https://datarhei.com/restreamer)) plus a
**split-channel** helper: fan one RTMP ingest out to a *monitor copy* (always the
first output) and *N egress destinations* (YouTube/Twitch/…), all stream-copied
so the split is CPU-cheap and lossless.

It has **no coupling to any app** — only Node's global `fetch` (or an injected
one). That's deliberate: it lives in Atem Overseer today and is meant to drop
into [flock](https://github.com/stoatworks-labs/flock) (or anything else) unchanged.

```
 encoder ──RTMP──▶  Restreamer / Core  ──▶ monitor copy  → your app's ingest
                          │              ├▶ destination 1 → rtmp://youtube…
                          └──────────────┴▶ destination 2 → rtmp://twitch…
```

## Usage

```ts
import { RestreamerClient, SplitManager } from '@av/restreamer';

const client = new RestreamerClient({
  url: 'http://restreamer.local:8080',
  username: 'admin',
  password: '…',
});

const split = new SplitManager(client, {
  referencePrefix: 'my-app',                 // namespaces processes on shared Restreamers
  ingest: { host: 'restreamer.local', port: 1935, app: 'live' },
});

// tell the encoder where to publish:
const push = split.ingestPushUrl('cam-a');   // rtmp://restreamer.local:1935/live/cam-a

// create/update the split: monitor copy + destinations
await split.sync('cam-a', 'rtmp://my-app-host:1935/live/cam-a', [
  { id: 'yt', name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'xxxx', enabled: true },
]);

const state = await split.state('cam-a', destinations, monitorUrl);   // running? provisioned?
await split.teardown('cam-a');
```

Without a live Restreamer (tests, demos), inject the mock transport:

```ts
import { RestreamerClient, createMockTransport } from '@av/restreamer';
const client = new RestreamerClient({ url: 'http://mock', username: 'x', password: 'y', fetch: createMockTransport() });
```

## Source types

A channel does not have to be fed by an encoder. `sync()` takes an optional
`ChannelSource`:

```ts
await split.sync('slate', monitorUrl, dests, {
  kind: 'file', path: 'media/holding-slate.mp4', loop: true, silentAudio: true,
});

await split.sync('lower-third', monitorUrl, dests, {
  kind: 'browser', url: 'https://example.com/l3',
  width: 1920, height: 1080, frameRate: '50',
  renderer: { url: 'http://weblinked.local:7654' },
});
```

```
 file   ─▶ [feeder process] ─┐
 ATEM   ──────RTMP───────────┼─▶ {rtmp,name=…} ─▶ [split, -c copy] ─▶ monitor + destinations
 page   ─▶ [WebLinked] ──────┘
```

**The split never changes.** Kinds that the Core has to play itself get a second
process upstream (`<splitId>-src`) that feeds the internal RTMP stream; `rtmp`
and `browser` are fed from outside it and get none. So the split stays a lossless
`-c copy` fan-out for every source type, and a channel encodes at most once
however many destinations it has.

- `{ kind: 'rtmp', name? }` — the default. Something else publishes to you.
- `{ kind: 'file', path, loop?, silentAudio?, encode? }` — `path` resolves on the
  **Core's** filesystem (a bare path becomes `{diskfs}/…`). `silentAudio` adds a
  lavfi silence track for a file with no audio, which most platforms require.
  Without `encode` the file is stream-copied.
- `{ kind: 'browser', url, width?, height?, frameRate?, videoBitrate?, renderer? }`
  — the Core has no browser, so this needs a renderer. `WebLinkedRenderer` drives
  [WebLinked](https://github.com/stoatworks-labs/weblinked) over its control API;
  implement `BrowserRenderer` for anything else. `frameRate` is an exact rational
  (`'50'`, `'60000/1001'`) — never a decimal.

`parseChannelSource(unknown)` validates untrusted input and throws with a reason,
so every app that ports this rejects the same things. `createMockRendererTransport()`
is an in-memory WebLinked for the same reason `createMockTransport()` exists.

`teardown()` removes both processes and releases the renderer's output, but
leaves the renderer's page loaded — a renderer may be shared.

## Porting to another app (e.g. flock)

Everything app-specific is passed in, not baked in:

1. Copy this package (or add it to the workspace).
2. Provide your app's **own ingest URL** as the `monitorUrl` in `sync()` — that's
   where the automatic copy lands so your app can display it.
3. Choose a unique **`referencePrefix`** (e.g. `flock`) so two apps can share one
   Restreamer without touching each other's processes.
4. Persist the per-channel `Destination[]` wherever your app keeps config and pass
   the current set into `sync()`.

That's the whole contract — no imports to rewrite.

## API surface

- `RestreamerClient` — `ping`, `listProcesses`, `getProcess`/`tryGetProcess`,
  `getState`, `createProcess`, `updateProcess`, `deleteProcess`, `command`.
- `SplitManager` — `sync`, `state`, `teardown`, `processId`, `sourceProcessId`,
  `ingestPushUrl`.
- `buildSplitProcessConfig(spec)` — pure; returns the Core process JSON.
- `buildSourceProcessConfig(spec, splitId)` — pure; the upstream feeder, or
  `null` for a kind that does not need one.
- `parseChannelSource`, `encodeOptions`, `fileAddress`, `needsSourceProcess`.
- `WebLinkedRenderer`, `createRenderer`, `rendererFormat`, `rendererOutputName`.
- `createMockTransport()`, `createMockRendererTransport()` — in-memory Core and
  renderer for tests/demos.
