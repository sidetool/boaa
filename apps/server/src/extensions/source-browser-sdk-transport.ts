import { Readable } from 'node:stream';
import type { SourceTransport } from './source-authentication.js';
import { authenticateSourceRequest, saveSourceBrowserCookies, sourceBrowserHeaders } from './source-browser-cookies.js';
import { sourceBrowserUsage } from './source-browser-mode.js';
import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';

/** Preserve the SDK's streaming, DNS pinning, authentication and asset ownership. */
export function sourceBrowserSdkSession(scope: SourceWebViewScope): NonNullable<SourceTransport['session']> {
  return async (approved, request, signal, transport) => {
    const current = request.response === 'asset' ? { ...scope, browserAllowed: false } : scope;
    const input = { url: approved.url.href, method: request.method, headers: request.headers, body: request.body };
    const usage = current.browserAllowed ? sourceBrowserUsage(current.browserUsage) : 'off';
    const response = await authenticateSourceRequest(
      input,
      current,
      signal,
      async () => {
        if (usage === 'always') {
          const result = await sourceWebViewHost.request(input, current, signal, 2 * 1024 * 1024, false);
          // Browser fetch returns decoded bytes. The SDK still verifies decoded length.
          const headers = Object.fromEntries(
            Object.entries(result.headers).flatMap(([key, value]) =>
              value === undefined || ['content-encoding', 'content-length'].includes(key)
                ? []
                : [[key, Array.isArray(value) ? value.join(', ') : value]],
            ),
          );
          return { ...result, headers, status: result.statusCode, body: Readable.from([result.bytes]) };
        }
        const raw = await transport(approved, { ...request, headers: sourceBrowserHeaders(input, current) }, signal);
        const result = { ...raw, statusCode: raw.status, url: approved.url.href };
        try {
          signal.throwIfAborted();
          saveSourceBrowserCookies(result, current);
          return result;
        } catch (error) {
          raw.body.destroy();
          throw error;
        }
      },
      (result) => result.body.destroy(),
    );
    return { status: response.status, headers: response.headers, body: response.body };
  };
}
