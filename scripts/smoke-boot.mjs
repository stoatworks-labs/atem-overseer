#!/usr/bin/env node
/**
 * Boot smoke-test: start the built server the way the packaged app does, and
 * prove it actually serves.
 *
 * `npm run typecheck` and `npm run build` cannot see this class of failure.
 * `app.get('*')` is a perfectly good TypeScript string; under Express 5 /
 * path-to-regexp 8 it throws while the route is being registered, so the
 * server died before it ever listened — and v0.3.3 through v0.3.6 all shipped
 * an app that could not start. Every assertion below exists because that
 * shipped.
 *
 *   node scripts/smoke-boot.mjs        # after npm run build
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';

/**
 * The defaults from packages/server/src/config.ts. The smoke-test runs with no
 * config file, so these are exactly the ports the server will bind — all
 * three, not just the dashboard, and a boot fails if any one of them is taken.
 */
const PORTS = [
  [4700, 'dashboard http'],
  [1935, 'rtmp ingest'],
  [8000, 'http-flv media'],
];
const HTTP_PORT = PORTS[0][0];

const BOOT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Spawn node on this file directly rather than going through `npm start`:
 * it is what the desktop bundle does (launcher/src-tauri/launcher.toml) and
 * what the container does (Dockerfile CMD), and npm brings an environment of
 * its own — see startServer.
 */
const entry = join(root, 'packages', 'server', 'dist', 'index.js');

/** What must answer, and what a failure of each one would mean. */
const CHECKS = [
  { path: '/', kind: 'html', what: 'the dashboard' },
  { path: '/devices', kind: 'html', what: 'a deep path, served by the SPA fallback' },
  { path: '/api/config', kind: 'json', what: 'the API' },
];

async function main() {
  checkRunDirectory();
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist. Run \`npm run build\` first.`);
  }
  await checkPorts();

  // A scratch directory to run in, fresh and empty, so any crash report found
  // afterwards is certainly ours — and so the working copy stays clean: the
  // media server writes ./.media and ./data relative to the working directory.
  // The packaged app runs from its app-config directory for the same reason.
  const runDir = mkdtempSync(join(tmpdir(), 'atem-overseer-smoke-'));
  const logDir = join(runDir, 'logs');
  say(`run dir ${runDir}`);

  const server = startServer(runDir, logDir);
  try {
    await waitForBoot(server);
    say(`listening on ${HOST}:${HTTP_PORT}`);
    await checkRoutes(server);
    await shutdownCleanly(server);
    say('shut down cleanly on SIGTERM');
  } catch (err) {
    if (!server.exited) server.child.kill('SIGKILL');
    // A crash report says far more about a failed boot than the exception we
    // caught out here, which usually only knows that nothing answered.
    const crashes = crashReports(logDir);
    if (!crashes.length) throw err;
    throw new Error(`${err.message}\n\nthe server wrote a crash report:\n${crashes.join('\n')}`);
  }

  // After the exit, not before it: this also catches a fault on the way down.
  const crashes = crashReports(logDir);
  if (crashes.length) {
    throw new Error(
      `the server served every route but wrote ${crashes.length} crash report(s):\n${crashes.join('\n')}`,
    );
  }
  say('no crash reports');
  say('OK');
}

/**
 * Refuse to run from a path with a dot-directory in it.
 *
 * The SPA fallback answers with `res.sendFile(<absolute path>)`, which hands
 * the whole path to `send`, whose `dotfiles` option defaults to `'ignore'` and
 * is tested against *every* segment of it — not just the part below the web
 * root. From a checkout under, say, `.claude/worktrees/`, a perfectly correct
 * fallback 404s, and this test would report a broken server that isn't.
 *
 * `express.static` passes a root and is unaffected, which is the nasty part:
 * `/` still serves the dashboard and only the deep path breaks.
 */
function checkRunDirectory() {
  // send's own rule for what counts as a dotfile: a segment starting with '.'
  // that is longer than one character.
  const dotted = root.split(sep).find((seg) => seg.length > 1 && seg.startsWith('.'));
  if (!dotted) return;
  throw new Error(
    `refusing to run from ${root}\n` +
      `  — the path segment "${dotted}" starts with a dot.\n\n` +
      `  res.sendFile() serves nothing from such a path: send() applies its\n` +
      `  dotfiles: 'ignore' default to every segment of the absolute path, so\n` +
      `  the SPA fallback would 404 and this test would fail for a reason that\n` +
      `  has nothing to do with the server. Run it from a checkout whose path\n` +
      `  has no dot segment (a git worktree under .claude/ is the usual cause).`,
  );
}

/** Nothing else may hold the server's ports, or the boot fails for the wrong reason. */
async function checkPorts() {
  for (const [port, what] of PORTS) {
    if (await portIsFree(port)) continue;
    const who = occupant(port);
    throw new Error(
      `port ${port} (${what}) is already in use, so the server cannot bind it.\n` +
        `  That is a busy machine, not a broken build.` +
        (who ? `\n\n${who}` : ''),
    );
  }
}

function portIsFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    // 0.0.0.0, because that is what the server binds: a listener on any
    // address would collide with it.
    probe.listen(port, '0.0.0.0');
  });
}

/** Best-effort "who holds it", so a busy port in CI names its owner. */
function occupant(port) {
  const attempts = [
    ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']],
    ['ss', ['-lptn', `sport = :${port}`]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {
      // Not installed, or it found nothing. Either way, try the next one.
    }
  }
  return '';
}

function startServer(runDir, logDir) {
  /*
   * A deliberately assembled environment, not an inherited one:
   *
   *  - npm_* is stripped because npm_package_version shadows the manifest the
   *    server reads from beside dist/, and the manifest is the path a packaged
   *    build actually takes. Running this through `npm run smoke` must not
   *    quietly test something else.
   *  - ATEM_OVERSEER_* is dropped wholesale and rebuilt here, so a developer's
   *    own port, host or config file cannot move the ports out from under the
   *    assertions above.
   */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('npm_') && !k.startsWith('ATEM_OVERSEER_'),
    ),
  );
  env.ATEM_OVERSEER_LOG_DIR = logDir;
  // Points at nothing on purpose: loadConfig() falls back to the defaults,
  // which is the fresh-install case and keeps the ports predictable.
  env.ATEM_OVERSEER_CONFIG = join(runDir, 'no-such.config.json');

  const server = {
    child: spawn(process.execPath, [entry], {
      cwd: runDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    exited: null,
  };
  server.child.on('exit', (code, signal) => {
    server.exited = { code, signal };
  });
  // Echoed live and prefixed: when this fails in CI, the server's own account
  // of the failure is already in the job log, in order, next to ours.
  echo(server.child.stdout);
  echo(server.child.stderr);
  return server;
}

function echo(stream) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) console.log(`  server | ${line}`);
  });
  stream.on('end', () => {
    if (pending) console.log(`  server | ${pending}`);
  });
}

async function waitForBoot(server) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new Error(
        `the server exited during startup (${describeExit(server)}) — it never listened on ${HTTP_PORT}.`,
      );
    }
    if (await answers(`http://${HOST}:${HTTP_PORT}/`)) return;
    await sleep(POLL_MS);
  }
  throw new Error(
    `nothing answered on http://${HOST}:${HTTP_PORT}/ within ${BOOT_TIMEOUT_MS / 1000}s.`,
  );
}

async function answers(url) {
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function checkRoutes(server) {
  for (const check of CHECKS) {
    const url = `http://${HOST}:${HTTP_PORT}${check.path}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      const gone = server.exited ? ` — the server has exited (${describeExit(server)})` : '';
      throw new Error(`GET ${check.path} (${check.what}) failed: ${err.message}${gone}`);
    }
    const body = await res.text();

    if (res.status !== 200) {
      throw new Error(
        `GET ${check.path} (${check.what}) returned ${res.status}, expected 200.` +
          (check.kind === 'html' && res.status === 404
            ? `\n  The SPA fallback did not match. Express 5 wants '/{*splat}';` +
              `\n  '*' is Express 4 syntax and throws at registration.`
            : ''),
      );
    }

    if (check.kind === 'html') {
      // The mount point from packages/web/index.html. A 200 alone would also
      // be satisfied by an error page, which is not what shipping looks like.
      if (!body.includes('id="root"')) {
        throw new Error(
          `GET ${check.path} returned 200 but not the dashboard shell (no #root mount point):` +
            `\n  ${body.slice(0, 200)}`,
        );
      }
    } else {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`GET ${check.path} returned 200 but not JSON:\n  ${body.slice(0, 200)}`);
      }
      if (!Array.isArray(json.devices)) {
        throw new Error(
          `GET ${check.path} returned JSON without a devices array:\n  ${body.slice(0, 200)}`,
        );
      }
    }

    say(`GET ${check.path} -> 200 (${check.what})`);
  }
}

async function shutdownCleanly(server) {
  server.child.kill('SIGTERM');
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!server.exited && Date.now() < deadline) await sleep(POLL_MS);

  if (!server.exited) {
    server.child.kill('SIGKILL');
    throw new Error(
      `the server ignored SIGTERM for ${SHUTDOWN_TIMEOUT_MS / 1000}s and had to be killed: ` +
        `its shutdown path is stuck.`,
    );
  }
  if (server.exited.code !== 0) {
    throw new Error(`the server exited ${describeExit(server)} on SIGTERM; a clean stop exits 0.`);
  }
}

/** Crash reports written during this run, summarised for a CI log. */
function crashReports(logDir) {
  // The same shape diag/reports.ts looks for when it assembles a bundle.
  let files;
  try {
    files = readdirSync(logDir).filter((f) => f.includes('-crash-') && f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((f) => summarise(join(logDir, f)));
}

function summarise(path) {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    return [
      `  ${path}`,
      `    trigger: ${report.trigger}`,
      `    error:   ${report.error?.name}: ${report.error?.message}`,
      ...(report.error?.stack ?? []).slice(1, 6).map((line) => `    ${line}`),
    ].join('\n');
  } catch (err) {
    return `  ${path} (could not be read: ${err.message})`;
  }
}

function describeExit(server) {
  const { code, signal } = server.exited;
  return signal ? `killed by ${signal}` : `exit code ${code}`;
}

function say(message) {
  console.log(`smoke: ${message}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

main().catch((err) => {
  console.error(`\nsmoke: FAILED — ${err.message}\n`);
  process.exitCode = 1;
});
