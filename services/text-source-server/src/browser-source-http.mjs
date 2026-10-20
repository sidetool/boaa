import { firefox } from 'playwright-core';
import { camoufoxLaunchOptions } from '../../../packages/browser-runtime/index.mjs';
import { SourceError } from './catalog.mjs';

const MAX_BYTES = 1024 * 1024;
// Legacy names are accepted only for configuration migration; every launch uses Camoufox.
const CHANNELS = new Set(['camoufox', 'chromium', 'chrome', 'msedge']);

function abortable(operation, signal) {
  let cancel;
  const aborted = new Promise((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  return Promise.race([operation, aborted]).finally(() => signal.removeEventListener('abort', cancel));
}

async function closeContext(context, browser) {
  if (!context) return;
  let timer;
  try {
    const closed = await Promise.race([
      context.close().then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    // A broken browser must not keep an aborted request or its admission slot alive.
    if (!closed) void browser?.close().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

/** Opt-in normal browser networking. No persistent profile, script execution, or identity overrides. */
export function createBrowserSourceHttp({ channel, timeoutMs = 15_000 } = {}) {
  if (
    (channel !== undefined && !CHANNELS.has(channel)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    throw new SourceError(500, 'invalid_source_http_transport');
  const shutdown = new AbortController();
  const waiting = [];
  let active = 0;
  let browserPromise;
  let disposing;

  function acquire(signal) {
    signal.throwIfAborted();
    if (active >= 2 && waiting.length >= 8) throw new SourceError(429, 'source_busy');
    return new Promise((resolve, reject) => {
      const entry = {
        start() {
          signal.removeEventListener('abort', cancel);
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.start();
          });
        },
      };
      const cancel = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (active < 2) entry.start();
      else waiting.push(entry);
    });
  }
  function browser() {
    if (!browserPromise) {
      browserPromise = camoufoxLaunchOptions()
        .then((options) => firefox.launch({ ...options, timeout: 15_000 }))
        .then(async (instance) => {
          if (shutdown.signal.aborted) {
            await instance.close();
            throw shutdown.signal.reason;
          }
          instance.on('disconnected', () => {
            browserPromise = undefined;
          });
          return instance;
        })
        .catch(() => {
          browserPromise = undefined;
          throw new SourceError(503, 'source_browser_unavailable');
        });
    }
    return browserPromise;
  }
  async function fetchImpl(input, init = {}) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new SourceError(502, 'source_url_rejected');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 4096
    )
      throw new SourceError(502, 'source_url_rejected');
    if (
      (init.method ?? 'GET') !== 'GET' ||
      init.body !== undefined ||
      (init.credentials !== undefined && init.credentials !== 'omit') ||
      (init.redirect !== undefined && init.redirect !== 'error')
    )
      throw new SourceError(502, 'source_request_rejected');
    const headers = new Headers(init.headers);
    const imageRequest = headers.get('accept') === 'image/jpeg, image/png, image/webp';
    const maximumBytes = imageRequest ? 8 * 1024 * 1024 : MAX_BYTES;
    if ([...headers.keys()].some((name) => !['accept', 'referer'].includes(name)))
      throw new SourceError(502, 'source_request_rejected');
    const abort = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, abort.signal, init.signal].filter(Boolean));
    const timer = setTimeout(() => abort.abort(new SourceError(504, 'source_timeout')), timeoutMs);
    let context;
    let instance;
    let release;
    const close = () => {
      void context?.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      release = await acquire(signal);
      instance = await abortable(browser(), signal);
      signal.throwIfAborted();
      context = await abortable(
        instance
          .newContext({
            viewport: null,
            serviceWorkers: 'block',
            acceptDownloads: false,
          })
          .then((created) => {
            if (signal.aborted) void closeContext(created, instance);
            return created;
          }),
        signal,
      );
      signal.throwIfAborted();
      const page = await abortable(context.newPage(), signal);
      page.on('response', (response) => {
        if (response.url() === url.href && Number(response.headers()['content-length']) > maximumBytes)
          abort.abort(new SourceError(502, 'source_response_limit'));
      });
      // Render only a host-owned inert document. Source bytes are streamed by fetch and never evaluated.
      const bootstrapUrl = new URL('/.boaa-browser-' + crypto.randomUUID(), url.origin).href;
      await abortable(
        context.routeWebSocket('**/*', (socket) => socket.close()),
        signal,
      );
      await abortable(
        context.route('**/*', async (route) => {
          const request = route.request();
          if (request.url() === bootstrapUrl && request.isNavigationRequest()) {
            await route.fulfill({
              status: 200,
              contentType: 'text/html',
              body: '<!doctype html><title>Browser transport</title>',
            });
          } else if (request.url() === url.href && request.method() === 'GET' && !request.redirectedFrom()) {
            await route.continue();
          } else {
            await route.abort();
          }
        }),
        signal,
      );
      await abortable(page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 0 }), signal);
      const readResponse = async ({ target, outgoing, maximum, images, idleMs }) => {
        const controller = new AbortController();
        let idle;
        const reset = () => {
          clearTimeout(idle);
          idle = setTimeout(() => controller.abort(), idleMs);
        };
        try {
          reset();
          const response = await fetch(target, {
            headers: outgoing,
            credentials: 'omit',
            redirect: 'manual',
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
            return { error: 'source_redirect_rejected' };
          if (Number(response.headers.get('content-length')) > maximum) return { error: 'source_response_limit' };
          const contentType = response.headers.get('content-type') || '';
          const mime = contentType.split(';')[0].trim().toLowerCase();
          if (
            !(images ? ['image/jpeg', 'image/png', 'image/webp'] : ['application/json', 'text/html']).includes(mime) ||
            [204, 205, 304].includes(response.status) ||
            !response.body
          )
            return { error: 'source_invalid_response' };
          const reader = response.body.getReader();
          const chunks = [];
          let length = 0;
          while (true) {
            reset();
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > maximum) return { error: 'source_response_limit' };
            for (let start = 0; start < value.length; start += 32768)
              chunks.push(btoa(String.fromCharCode(...value.subarray(start, start + 32768))));
          }
          return { status: response.status, contentType, length, chunks };
        } catch {
          return { error: controller.signal.aborted ? 'source_timeout' : 'source_request_failed' };
        } finally {
          clearTimeout(idle);
          controller.abort();
        }
      };
      const parameters = {
        target: url.href,
        outgoing: Object.fromEntries(headers),
        maximum: maximumBytes,
        images: imageRequest,
        idleMs: Math.min(timeoutMs, 10000),
      };
      const result = await abortable(
        page.evaluate('mw:(' + readResponse.toString() + ')(' + JSON.stringify(parameters) + ')'),
        signal,
      );
      if (result.error) throw new SourceError(result.error === 'source_timeout' ? 504 : 502, result.error);
      const bytes = Buffer.concat(
        result.chunks.map((chunk) => Buffer.from(chunk, 'base64')),
        result.length,
      );
      return new Response(bytes, {
        status: result.status,
        headers: { 'Content-Type': result.contentType, 'Content-Length': String(bytes.length) },
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof SourceError) throw error;
      throw new SourceError(502, 'source_request_failed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      await closeContext(context, instance);
      release?.();
    }
  }
  function dispose() {
    return (disposing ??= (async () => {
      shutdown.abort(new SourceError(503, 'server_stopping'));
      const instance = await browserPromise?.catch(() => undefined);
      await instance?.close();
    })());
  }
  return { fetchImpl, dispose };
}
