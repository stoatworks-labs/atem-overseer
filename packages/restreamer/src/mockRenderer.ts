import type { FetchLike } from './types.js';

function res(status: number, body?: unknown): ReturnType<FetchLike> {
  const text = body === undefined ? '' : JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  });
}

interface MockOutput {
  kind: string;
  name: string;
  running: boolean;
  enabled: boolean;
  options?: Record<string, unknown>;
}

/**
 * In-memory WebLinked, exposing the subset of its control API that a browser
 * source drives: navigate, set format, and add/update/remove the stream output
 * that publishes into the Core's ingest.
 *
 * The point is that `--mock` can exercise the *whole* browser-source path —
 * including "the renderer says it is publishing" — with nothing running. It is
 * a simulation of the contract, not evidence the contract is right; only a real
 * WebLinked can be that.
 */
export function createMockRendererTransport(): FetchLike {
  const outputs = new Map<string, MockOutput>();
  let loadedUrl = '';
  let format = '1920x1080p50';

  return (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (pathname === '/api/state' && method === 'GET') {
      return res(200, {
        version: 'mock',
        running: true,
        format,
        outputs: [...outputs.values()],
        compiled_backends: ['preview', 'stream'],
        source: { url: loadedUrl, loaded_url: loadedUrl, loading: false },
      });
    }

    if (method !== 'POST') return res(404, { error: `mock renderer: no route for ${method} ${pathname}` });

    switch (pathname) {
      case '/api/url':
        loadedUrl = String(body?.url ?? '');
        return res(200, { ok: true });

      case '/api/format':
        format = String(body?.format ?? format);
        // A format change restarts every output, exactly as the real one does.
        for (const o of outputs.values()) o.running = o.enabled;
        return res(200, { ok: true });

      case '/api/output/add': {
        const name = String(body?.name ?? '');
        if (!name) return res(400, { error: 'output needs a name' });
        if (outputs.has(name)) return res(409, { error: `duplicate output ${name}` });
        outputs.set(name, {
          kind: String(body?.kind ?? 'stream'),
          name,
          running: true,
          enabled: true,
          options: body?.options,
        });
        return res(200, { ok: true });
      }

      case '/api/output/update': {
        const name = String(body?.name ?? '');
        const existing = outputs.get(name);
        if (!existing) return res(404, { error: `no output ${name}` });
        const next = body?.output ?? {};
        outputs.delete(name);
        const renamed = String(next.name ?? name);
        outputs.set(renamed, {
          kind: String(next.kind ?? existing.kind),
          name: renamed,
          running: true,
          enabled: true,
          options: next.options ?? existing.options,
        });
        return res(200, { ok: true });
      }

      case '/api/output/remove': {
        const name = String(body?.name ?? '');
        return outputs.delete(name) ? res(200, { ok: true }) : res(404, { error: `no output ${name}` });
      }

      default:
        return res(404, { error: `mock renderer: no route for ${method} ${pathname}` });
    }
  };
}
