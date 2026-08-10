# Restreamer split pipeline

By default an ATEM streams straight into Overseer's built-in RTMP ingest. Enable
the **Restreamer integration** and the topology changes to a fan-out:

```
                         ┌──────────────────────────────────────────┐
 ATEM ──RTMP──▶ Restreamer (datarhei Core) ──▶ monitor copy ──▶ Overseer ingest ──▶ tile preview
                         │                    ├▶ YouTube
                         │                    ├▶ Twitch
                         └────────────────────┴▶ … more destinations
```

The ATEM streams **once**, to Restreamer. Overseer then asks Restreamer (over its
Core API) to run a *split process* that stream-copies (`-c copy`, so it's
CPU-cheap and lossless) the ingest to:

- **output 0 — the monitor copy**, pushed back into Overseer's own ingest so the
  tile preview keeps working exactly as before, and
- **outputs 1…N — your egress destinations** (YouTube/Twitch/custom RTMP),
  managed per-device from Overseer's gear panel.

## Enabling it

You need a running Restreamer / datarhei Core reachable from Overseer. Don't have
one? Grab a compose file from any device's ⚙ → **Restreamer → docker-compose.yml**
(or `GET /api/restreamer/compose`) and `docker compose up -d`.

Add a `restreamer` block to `atem-overseer.config.json`:

```json
{
  "restreamer": {
    "enabled": true,
    "url": "http://restreamer.local:8080",
    "username": "admin",
    "password": "…",
    "rtmpHost": "restreamer.local",
    "rtmpPort": 1935,
    "rtmpApp": "",
    "rtmpToken": "optional-publish-token",
    "referencePrefix": "atem-overseer"
  }
}
```

- `url` / `username` / `password` — the Core API (Restreamer web UI login).
- `rtmpHost`/`rtmpPort`/`rtmpApp`/`rtmpToken` — how the **ATEM** reaches
  Restreamer's RTMP ingest. This is what the generated `Streaming.xml` and the
  "Apply local service to switcher" button now point at.

> **`rtmpApp` must match the Core's own `rtmp.app`, and on a stock Restreamer
> that is `/` — so leave it empty.** `{rtmp,name=cam-a}` expands to
> `rtmp://localhost:1935/cam-a` with no app segment, so an encoder pointed at
> `…/live/cam-a` publishes a stream the split is not listening to. Nothing
> errors: both processes run, both look healthy, and no video ever arrives.
> Check it with `GET /api/v3/config` → `rtmp.app` rather than assuming.

> **Ports:** if Restreamer runs on the *same host* as Overseer, give them
> different RTMP ports — both default to 1935. Separate hosts are simplest.

## Using it

Per device, open ⚙ → **Restreamer**:

1. **Provision** — creates/updates the split process on Restreamer and starts it.
2. **Point the ATEM** at the shown push URL (`rtmp://…/live/<deviceId>`). The
   Streaming.xml already targets Restreamer when the integration is on.
3. **Egress destinations** — add name + RTMP URL + stream key, toggle each on/off,
   **Save**. Saving re-syncs the live process. The monitor copy is always kept.
4. **Tear down** removes the process from Restreamer.

## How it's built (and porting to flock)

All the Restreamer logic lives in a standalone, framework-agnostic package,
[`packages/restreamer`](../packages/restreamer) (`@av/restreamer`) — a datarhei
Core client plus a `SplitManager`. It has **no Overseer coupling**: the app passes
in its own monitor-ingest URL and a `referencePrefix`.

To add the same feature to **flock**: copy `packages/restreamer` in, then wire ~4
REST endpoints to a `SplitManager`, passing flock's own ingest URL as the monitor
target and `referencePrefix: "flock"` (so both apps can share one Restreamer
without clobbering each other's processes). See the package's
[README](../packages/restreamer/README.md) for the exact contract.

## Source types

By default a channel is fed by its **ATEM**, publishing to Restreamer's RTMP
ingest. A channel can instead be fed by a file or by a web page — the ⚙ →
**Restreamer** → **Source** control, or `PUT /api/devices/:id/restreamer/source`:

| Kind | What feeds the ingest |
|---|---|
| `rtmp` *(default)* | The ATEM, exactly as before |
| `file` | An extra Restreamer process plays a file into the ingest |
| `browser` | WebLinked renders a page and publishes to the ingest |

**Downstream of the ingest all three are identical.** The split still reads the
same internal stream and still fans it out with `-c copy`, so the monitor copy
and every destination work unchanged whatever is feeding them. That is why a
file source gets its *own* Restreamer process rather than teaching the split to
decode: it encodes once, no matter how many destinations the channel has.

```json
{ "source": { "kind": "file", "path": "media/holding-slate.mp4",
              "loop": true, "silentAudio": true } }
```

`path` is on the **Restreamer's** filesystem, not Overseer's — a bare path is
relative to its disk storage, and an absolute path or an `http(s)://` URL is
passed to ffmpeg as-is. `silentAudio` adds a silent stereo track for a file that
has none, because most platforms drop or reject a video-only stream. Leave
`encode` unset to stream-copy an H.264/AAC file; set it to re-encode anything
else.

```json
{ "source": { "kind": "browser", "url": "https://example.com/slate",
              "width": 1920, "height": 1080, "frameRate": "50",
              "renderer": { "url": "http://weblinked.local:7654" } } }
```

Restreamer has no browser and never will, so a browser source needs a renderer:
[WebLinked](https://github.com/stoatworks-labs/weblinked), whose `stream` output
publishes RTMP. Overseer drives it over its control API — sets the format, loads
the page, and adds a stream output aimed at this channel's ingest, named
`<referencePrefix>-<deviceId>` so two apps can share one renderer. Set
`restreamer.renderer` in the config to give every browser source the same
renderer without repeating it.

`frameRate` must be exact: `50`, or `60000/1001` — never `59.94`, which is a
different rate and drifts about 40 ms a minute. The API rejects a decimal.

**Tearing a channel down releases the renderer's output but leaves the page
loaded**, since a renderer may be shared and blacking out someone else's feed is
not what "tear down this channel" should mean.

### What this does not do

A source is a property of a **device's** channel — the channel keys are device
ids. So a file or a page replaces what that ATEM would have streamed (useful:
that is a holding slate on a switcher that is off air) but there is no way yet
to create a standalone channel that has no ATEM behind it at all.

## Caveat

**Verified against a live Restreamer** (datarhei Core **16.0.0**) on 2026-08-10,
end to end, for all three source kinds. Previously this section said the whole
integration was mock-only; that is no longer true.

What was actually run, with the monitor copy pulled back out of Overseer's own
http-flv and inspected — not just "the process says running":

| | |
|---|---|
| **file** | An 8 s 720p25 clip uploaded to Core storage, looped. Feeder reported `copy: true`, 552 frames, **0 drop**; split 449 frames, **0 drop**. The monitor copy arrived carrying the clip's own burnt-in timecode and its 440 Hz tone (measured at 439 Hz). |
| **browser** | WebLinked rendering a page and publishing RTMP into the Core over the tailnet. Split took h264 1280x720 in at **0 drop**; WebLinked reported `connected`, 652 frames, 0 dropped, `audio_deficit_ms: 0`. The monitor copy showed the page. |
| **egress** | A destination added to a *running* channel re-synced live: the split gained a second output and both fed simultaneously, **0 drop**. |
| **lifecycle** | Switching `file` → `browser` deleted the feeder process; teardown left the Core with exactly the 8 processes it started with. |

`{diskfs}/…` and `{rtmp,name=…}` both expand as documented, and Core accepts
these process definitions unchanged.

### The one thing that was wrong, and it was silent

`rtmpApp` defaulted to `"live"`. Stock Restreamer's `rtmp.app` is `/`, so
`{rtmp,name=slate}` expands to `rtmp://localhost:1935/slate` — **no app
segment**. An encoder pointed at `…/live/slate` would have published a stream
the split was not listening to, with both processes running and reporting
healthy and no video ever arriving. The default is now empty and
`ingestPushUrl()` no longer emits a stray `//`. Check `GET /api/v3/config` →
`rtmp.app` against your own instance rather than assuming either value.

### Still not verified

A real egress *platform* — the destination test pushed to a loopback RTMP
endpoint, not to YouTube or Twitch, so nothing here says anything about their
handshakes or their tolerances. Nor has any of this run against a live ATEM: the
`rtmp` source kind was exercised by the split reading an ingest, not by a
switcher publishing to one.
