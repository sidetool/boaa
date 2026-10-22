import { createHash } from 'node:crypto';
import { browserEngine } from '@boaa/browser-runtime';
import type { CompatibilityHttpInput } from './mangayomi/http.js';
import type { SourceWebViewScope } from './source-webview.js';

const lifetimeMs = 30 * 60_000;
const maximumRoutes = 64;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Small, encrypted hint table, separate from cookies. No browser, timers or URL text is retained. */
export function sourceBrowserRouteMemory(input: CompatibilityHttpInput, scope: SourceWebViewScope) {
  let parts: string[];
  try {
    parts = JSON.parse(scope.key);
  } catch {
    parts = [scope.key, 'browser', ''];
  }
  if (!Array.isArray(parts)) parts = [scope.key, 'browser', ''];
  // Keep one bounded table per source/engine. A network or extension change replaces the table.
  parts[1] = `${parts[1]}:routes:${browserEngine()}-v1`;
  const key = JSON.stringify(parts);
  const partition = hash([scope.outboundProxy ?? '', scope.routeRevision ?? '']);
  const url = new URL(input.url);
  const route = hash([
    input.method ?? 'GET',
    url.origin,
    url.pathname,
    [...new Set(url.searchParams.keys())].sort(),
    Object.entries(input.headers ?? {})
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(),
  ]);
  function read(): Record<string, number> {
    const raw = scope.vault?.read(key)?.secret;
    if (!raw) return {};
    try {
      const saved = JSON.parse(raw);
      if (saved.partition !== partition || !saved.routes || typeof saved.routes !== 'object') return {};
      return Object.fromEntries(
        Object.entries(saved.routes)
          .filter(
            ([id, expires]) =>
              /^[a-f0-9]{64}$/.test(id) &&
              typeof expires === 'number' &&
              expires > Date.now() &&
              expires <= Date.now() + lifetimeMs,
          )
          .slice(-maximumRoutes),
      ) as Record<string, number>;
    } catch {
      return {};
    }
  }
  function write(remember: boolean) {
    if (!scope.vault) return;
    const routes = read();
    delete routes[route];
    if (remember) routes[route] = Date.now() + lifetimeMs;
    const bounded = Object.fromEntries(Object.entries(routes).slice(-maximumRoutes));
    scope.vault.write(key, { secret: JSON.stringify({ partition, routes: bounded }) });
  }
  return {
    prefersBrowser: () => !!read()[route],
    remember: () => write(true),
    forget: () => write(false),
  };
}
