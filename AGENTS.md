# AGENTS.md — bringing an LLM up to speed on Atem Overseer

Orientation for an AI assistant (or a new human) picking this project up cold. `CLAUDE.md`
holds the short command reference; this file explains the model and the traps.

---

## 1. What this is

A browser-based dashboard for **monitoring and controlling a fleet of Blackmagic ATEM
switchers from one screen**, styled after Blackmagic's own multiviewer.

Node/TypeScript, npm-workspaces monorepo. Public repo. Ships an av-launcher desktop app plus
multi-platform release CI. Phase 1 is built and verified.

## 2. Where this sits among the ATEM projects

There are three ATEM projects in this fleet and they are easy to confuse:

| Repo | Purpose |
|---|---|
| **atem-overseer** (this) | *Monitor and control* a fleet, live, from one dashboard |
| **atem-fleet-admin** | *Provision/configure* many switchers at once (XML export or live apply) |
| **animATEM** | *Control one* switcher, with UVC multiview compositing for SuperSource/DVE |

Before adding a feature, check it belongs here rather than in one of the siblings.

## 3. Layout

```
packages/
  restreamer   @av/restreamer library. Built FIRST (build:libs).
  server       @atem-overseer/server - backend
  web          @atem-overseer/web - frontend
```

**`build:libs` must run before server or web.** The dev and build scripts do this
automatically; if you see phantom type errors, that's usually the cause.

## 4. Commands

```bash
npm run dev:mock     # <- DEFAULT for development. Simulated ATEM fleet, no hardware.
npm run dev          # against real devices
npm run dev:web      # web only
npm run build
npm run typecheck
npm start            # start the built server

npm start -- --collect-diagnostics    # write one JSON file explaining the state of things
npm run diag:crash-example --workspace @atem-overseer/server   # see what a crash report looks like
```

**Logging: use `log` from `src/diag/index.js`, not `console`.** It writes a
rotating human-readable file *and* keeps an in-memory ring that gets embedded
into a crash report when the process dies. `console.log` bypasses both, and
anything you put on stdout corrupts `--collect-diagnostics`, whose stdout is a
path. See [docs/diagnostics.md](docs/diagnostics.md).

## 5. The working rule: develop against `--mock`

**`dev:mock` is the intended development mode.** A whole simulated switcher fleet is built
in, so no hardware is needed, and the entire Phase 1 verification was done this way.

Verify every change against mock *before* pointing anything at real devices. This isn't
timidity — a fleet dashboard sends commands to switchers that may be live on air.

## 6. Status — be precise about it

Developed and verified end-to-end **against the built-in simulated fleet (`--mock`)**. It has
**not** been run against live ATEM hardware.

The README specifically calls out transport, streaming and media-upload behaviour as things
to validate against your own switchers first. Those are the paths where a simulator is least
likely to match reality, so don't let them be described as proven.

## 7. Conventions

- Ships as its own desktop app via **av-launcher**. Note the macOS Gatekeeper trap common to
  all av-launcher apps: for an unsigned `.app` bundling helper binaries, approving the app
  does **not** unquarantine its payload — helpers are SIGKILLed silently.
- Multi-platform release CI; cross-compile macOS x86_64 on `macos-14` — never `macos-13`.
- Public repo. "Commit" means commit **and** push.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
