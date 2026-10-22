import type { CompatibilityHttpInput } from './mangayomi/http.js';
import type { SourceWebViewScope } from './source-webview.js';
import { sourceBrowserUsage } from './source-browser-mode.js';
import { refreshSourceBrowserSession } from './source-browser-refresh.js';
import { sourceBrowserRouteMemory } from './source-browser-route-memory.js';

interface Response {
  statusCode: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
const challenge = (response: Response) =>
  [403, 503].includes(response.statusCode) && response.headers['cf-mitigated'] === 'challenge';
const successful = (response: Response) =>
  response.statusCode >= 200 && response.statusCode < 300 && response.headers['cf-mitigated'] !== 'challenge';

/** Shared by SDK and compatibility HTTP. Only confirmed read challenges permit an automatic replay. */
export async function automaticSourceRequest<T extends Response>(
  input: CompatibilityHttpInput,
  scope: SourceWebViewScope,
  signal: AbortSignal,
  http: () => Promise<T>,
  browser: () => Promise<T>,
  discard: (response: T) => void = () => {},
): Promise<T> {
  signal.throwIfAborted();
  const usage = scope.browserAllowed ? sourceBrowserUsage(scope.browserUsage) : 'off';
  if (usage === 'always') return browser();
  if (usage === 'off' || !['GET', 'HEAD'].includes(input.method ?? 'GET')) return http();

  const memory = sourceBrowserRouteMemory(input, scope);
  if (memory.prefersBrowser()) {
    let response: T;
    try {
      response = await browser();
    } catch (error) {
      signal.throwIfAborted();
      memory.forget();
      // Only an unavailable optional component permits HTTP fallback from a learned route.
      // Do not hide origin denials, response limits, timeouts or cancellation.
      if ((error as Error).message !== 'source_browser_unavailable') throw error;
      return http();
    }
    if (signal.aborted) {
      discard(response);
      signal.throwIfAborted();
    }
    if (successful(response)) return response; // Fixed expiry: continued traffic cannot pin the browser forever.
    discard(response);
    memory.forget();
    return http();
  }

  let response = await http();
  if (!challenge(response)) return response;
  try {
    await refreshSourceBrowserSession(
      response.url,
      new URL(response.url).origin === new URL(input.url).origin ? input.headers : undefined,
      scope,
      signal,
    );
  } catch (error) {
    if ((error as Error).message === 'source_browser_unavailable' && !signal.aborted) return response;
    discard(response);
    throw error;
  }
  discard(response);
  response = await http();
  // Transferable clearance keeps all subsequent traffic on HTTP with saved cookies/identity.
  if (!challenge(response)) return response;
  let result: T;
  try {
    result = await browser();
  } catch (error) {
    if ((error as Error).message === 'source_browser_unavailable' && !signal.aborted) return response;
    discard(response);
    throw error;
  }
  discard(response);
  if (signal.aborted) {
    discard(result);
    signal.throwIfAborted();
  }
  if (successful(result)) {
    try {
      memory.remember();
    } catch (error) {
      discard(result);
      throw error;
    }
  }
  return result;
}
