import { browserEngine } from '@boaa/browser-runtime';
import type { Page } from 'playwright-core';

export interface BrowserResponseMetadata {
  statusCode: number;
  headers: Record<string, string | string[]>;
}

/** Chromium applies Playwright header overrides to its entire redirect chain.
 * Intercept each actual network hop instead, including opaque manual redirects.
 * Firefox's routing already pauses every hop. Neither path fetches in Node.
 */
export async function routeSourceBrowserPage(
  page: Page,
  options: {
    initialOrigin: string;
    headers: Record<string, string>;
    permitted: (url: string) => URL;
    maximumRequests: number;
    documentOnly: boolean;
    failure: (message: string) => void;
  },
) {
  const inert = new Set<string>();
  const responses = new Map<string, BrowserResponseMetadata>();
  let requests = 0;
  const headersFor = (raw: string, original: Record<string, string>, resourceType: string) => {
    const url = options.permitted(raw);
    if (++requests > options.maximumRequests) throw new Error('source_body_limit');
    if (options.documentOnly && ['image', 'media'].includes(resourceType.toLowerCase())) return undefined;
    const headers = Object.fromEntries(Object.entries(original).map(([name, value]) => [name.toLowerCase(), value]));
    delete headers['proxy-authorization'];
    if (url.origin === options.initialOrigin) Object.assign(headers, options.headers);
    else
      for (const [name, value] of Object.entries(options.headers)) {
        if (headers[name] === value) delete headers[name];
      }
    return headers;
  };
  const html = '<!doctype html><title>Source transport</title>';
  if (browserEngine() === 'patchright') {
    const session = await page.context().newCDPSession(page);
    const urls = new Map<string, string>();
    session.on('Fetch.requestPaused', (event) => {
      void (async () => {
        const id = event.requestId;
        try {
          if (event.responseStatusCode !== undefined || event.responseErrorReason) {
            const url = urls.get(id) ?? event.request.url;
            const headers: Record<string, string | string[]> = {};
            for (const row of event.responseHeaders ?? []) {
              const name = row.name.toLowerCase();
              const before = headers[name];
              headers[name] =
                before === undefined ? row.value : [...(Array.isArray(before) ? before : [before]), row.value];
            }
            responses.set(url, { statusCode: event.responseStatusCode ?? 502, headers });
            urls.delete(id);
            await session.send('Fetch.continueResponse', { requestId: id });
            return;
          }
          if (inert.has(event.request.url)) {
            await session.send('Fetch.fulfillRequest', {
              requestId: id,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
              body: Buffer.from(html).toString('base64'),
            });
            return;
          }
          const headers = headersFor(event.request.url, event.request.headers, event.resourceType);
          if (!headers) {
            await session.send('Fetch.failRequest', { requestId: id, errorReason: 'Aborted' });
            return;
          }
          urls.set(id, event.request.url);
          await session.send('Fetch.continueRequest', {
            requestId: id,
            headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
          });
        } catch (error) {
          options.failure((error as Error).message);
          await session.send('Fetch.failRequest', { requestId: id, errorReason: 'Aborted' }).catch(() => undefined);
        }
      })();
    });
    await session.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });
  } else {
    await page.route('**/*', async (route) => {
      try {
        const request = route.request();
        if (inert.has(request.url())) {
          await route.fulfill({ status: 200, contentType: 'text/html', body: html });
          return;
        }
        const headers = headersFor(request.url(), await request.allHeaders(), request.resourceType());
        if (!headers) {
          await route.abort('failed');
          return;
        }
        delete headers.host;
        delete headers.cookie;
        delete headers['content-length'];
        delete headers.connection;
        await route.continue(Object.keys(options.headers).length ? { headers } : undefined);
      } catch (error) {
        options.failure((error as Error).message);
        await route.abort('failed').catch(() => undefined);
      }
    });
  }
  return { inert, responses };
}
