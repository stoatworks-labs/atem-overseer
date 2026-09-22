# atem-overseer

Browser dashboard to monitor & control a fleet of Blackmagic ATEM switchers (BMD-multiview styled). Node/TS npm-workspaces monorepo (restreamer lib + server + web). Ships an av-launcher desktop app + multi-platform release CI. Phase 1 built & verified against `--mock`.

## Commands (npm, from repo root)
- Dev (real devices): `npm run dev`
- Dev (mock ATEMs): `npm run dev:mock`  ← default for development
- Dev web only: `npm run dev:web`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Start built server: `npm start`
- Boot smoke-test (after build): `npm run smoke`

## Layout (packages/)
- `restreamer` — `@av/restreamer` lib; built first (`build:libs`)
- `server` — backend (`@atem-overseer/server`)
- `web` — frontend (`@atem-overseer/web`)

## Notes
- Develop against `dev:mock` — no hardware needed; verify changes there before real devices.
- `build:libs` must run before server/web (dev/build scripts do this).
- `npm run smoke` boots `packages/server/dist/index.js` and asserts it serves; it refuses to run from a path containing a dot segment (so not from a worktree under `.claude/`) because `res.sendFile()` 404s from one.
- Public repo. Multi-platform release CI; cross-compile macOS x86_64 on macos-14 (never macos-13). "Commit" = commit **and** push.
