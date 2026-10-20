import { openSourceBrowserProxy } from './source-browser-proxy.js';
import { sourceBrowserLimits } from './source-browser-limits.js';
import { readBrowserSession, mergeBrowserSession } from './source-browser-session.js';
import { launchSourceBrowser } from './source-browser-launch.js';
import { firefox, type Browser, type BrowserContext } from 'playwright-core';
import {
  validSourceWebViewRequest,
  type SourceWebViewRequest,
} from '../../../../packages/extension-contracts/source-webview.js';
import type { SourceCredentialVault } from './source-credential-vault.js';

async function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal, cleanup?: (value: T) => void): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise.then((value) => {
        if (signal.aborted) cleanup?.(value);
        return value;
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('source_request_timeout'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function boundedClose(promise: Promise<unknown>, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SourceWebViewScope {
  /** Package/source/credential epoch in the owner's vault; never supplied by guest code. */
  key: string;
  vault?: SourceCredentialVault;
  /** Undefined only for the already-reviewed compatibility runtime's public network grant. */
  origins?: readonly string[];
  privateOrigins?: readonly string[];
  outboundProxy?: string;
  browserMode?: 'camoufox';
  /** Image discovery may load a whole chapter before its collector returns URLs. */
  purpose?: 'image-pages';
}

/** Two warm browser slots, with a separate short-lived context for each source invocation. */
const browserVaultIds = new WeakMap<SourceCredentialVault, number>();
let browserVaultSequence = 0;
function browserAdmissionKey(scope: SourceWebViewScope): string {
  if (!scope.vault) return `anonymous:${scope.key}`;
  let id = browserVaultIds.get(scope.vault);
  if (!id) {
    id = ++browserVaultSequence;
    browserVaultIds.set(scope.vault, id);
  }
  return `${id}:${scope.key}`;
}

export class SourceWebViewHost {
  private browsers = new Map<string, Promise<Browser>>();
  private idle?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private active = 0;
  private scopes = new Set<string>();
  private slots = new Set<number>();
  private wake = new Set<() => void>();

  private async releaseContext(context: BrowserContext, browser: Browser, engine: string) {
    if (await boundedClose(context.close())) return;
    // A stalled proxy connection can make context close hang. Discard that connection before admitting reuse.
    if ((await this.browsers.get(engine)?.catch(() => undefined)) === browser) this.browsers.delete(engine);
    void browser.close().catch(() => undefined);
  }

  private async launch(engine: string): Promise<Browser> {
    clearTimeout(this.idle);
    if (!this.browsers.has(engine)) {
      this.browsers.set(
        engine,
        (async () => {
          return launchSourceBrowser(firefox);
        })().catch((error) => {
          this.browsers.delete(engine);
          throw new Error('source_browser_unavailable', { cause: error });
        }),
      );
    }
    const browser = await this.browsers.get(engine)!;
    if (!browser.isConnected()) {
      this.browsers.delete(engine);
      return this.launch(engine);
    }
    return browser;
  }

  async evaluate(input: SourceWebViewRequest, scope: SourceWebViewScope, signal: AbortSignal): Promise<unknown> {
    const admissionKey = browserAdmissionKey(scope);
    if (!validSourceWebViewRequest(input)) throw new Error('invalid_source_invocation');
    const permitted = (raw: string) => {
      const url = new URL(raw);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (scope.origins && !scope.origins.includes(url.origin) && !scope.privateOrigins?.includes(url.origin))
      )
        throw new Error('source_url_denied');
      return url;
    };
    const initial = permitted(input.url);
    const limits = sourceBrowserLimits(scope.purpose);
    if (this.pending >= 64) throw new Error('execution_busy');
    this.pending++;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs ?? 60000)]);
    let proxy: Awaited<ReturnType<typeof openSourceBrowserProxy>> | undefined;
    let context: BrowserContext | undefined;
    let browser: Browser | undefined;
    let slot = -1;
    let engine = 'camoufox:0';
    let admitted = false;
    const notify = () => {
      for (const next of [...this.wake]) next();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (deadline.aborted) {
            cleanup();
            reject(new Error(signal.aborted ? 'cancelled' : 'source_request_timeout'));
          } else if (this.active < 2 && !this.scopes.has(admissionKey)) {
            this.active++;
            slot = this.slots.has(0) ? 1 : 0;
            this.slots.add(slot);
            engine = `camoufox:${slot}`;
            this.scopes.add(admissionKey);
            admitted = true;
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          this.wake.delete(check);
          deadline.removeEventListener('abort', check);
        };
        this.wake.add(check);
        deadline.addEventListener('abort', check, { once: true });
        check();
      });
      browser = await beforeDeadline(this.launch(engine), deadline);
      deadline.throwIfAborted();
      const saved = readBrowserSession(scope);
      const suppliedHeaders = Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      // Fingerprint identity is generated by Camoufox; legacy source Chrome UAs must not override it.
      delete suppliedHeaders['user-agent'];
      delete suppliedHeaders['proxy-authorization'];
      proxy = await openSourceBrowserProxy(scope, deadline);
      context = await beforeDeadline(
        browser.newContext({
          serviceWorkers: 'block',
          acceptDownloads: false,
          viewport: null,
          storageState: { cookies: saved.cookies, origins: saved.origins },
          ...(proxy ? { proxy: proxy.proxy } : {}),
        }),
        deadline,
        (late) => {
          void this.releaseContext(late, browser!, engine);
        },
      );
      if (suppliedHeaders.cookie) {
        const cookies = suppliedHeaders.cookie.split(';').flatMap((part) => {
          const index = part.indexOf('=');
          return index > 0
            ? [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: initial.origin + '/' }]
            : [];
        });
        await context.addCookies(cookies);
        delete suppliedHeaders.cookie;
      }
      const close = () => {
        void context?.close().catch(() => undefined);
      };
      deadline.addEventListener('abort', close, { once: true });
      let requests = 0;
      let navigationFailure: string | undefined;
      try {
        return await beforeDeadline(
          (async () => {
            deadline.throwIfAborted();
            await context.routeWebSocket('**/*', (socket) => socket.close());
            const bootstrap = await context.newPage();
            await bootstrap.goto(proxy!.bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
            await bootstrap.close();
            const visited = new Set<string>();
            await context.route('**/*', async (route) => {
              try {
                const request = route.request();
                const url = permitted(request.url());
                if (++requests > limits.requests) throw new Error('source_body_limit');
                const headers = await request.allHeaders();
                delete headers.host;
                delete headers.cookie;
                delete headers['content-length'];
                delete headers.connection;
                delete headers['proxy-authorization'];
                if (url.origin === initial.origin) Object.assign(headers, suppliedHeaders);
                // Browser cookies stay in its jar; caller headers apply only to the initial origin.
                visited.add(url.origin);
                if (url.origin !== initial.origin && suppliedHeaders.authorization === headers.authorization)
                  delete headers.authorization;
                await route.continue(Object.keys(suppliedHeaders).length ? { headers } : undefined);
              } catch (error) {
                if (route.request().isNavigationRequest()) navigationFailure = (error as Error).message;
                await route.abort('failed').catch(() => undefined);
              }
            });
            const page = await context.newPage();
            page.on('popup', (popup) => {
              void popup.close().catch(() => undefined);
            });
            let response = await page.goto(input.url, { waitUntil: input.waitUntil ?? 'domcontentloaded', timeout: 0 });
            if ([403, 503].includes(response?.status() ?? 0)) {
              response = await page
                .waitForResponse(
                  (res) => res.request().isNavigationRequest() && res.frame() === page.mainFrame() && res.ok(),
                  { timeout: 10000 },
                )
                .catch(() => response!);
              if (response?.ok())
                await page.waitForLoadState(input.waitUntil ?? 'domcontentloaded', { timeout: 10000 });
            }
            if (!response?.ok())
              throw new Error(
                navigationFailure ??
                  proxy?.failure ??
                  (response?.status() === 401 || response?.status() === 403
                    ? 'source_access_denied'
                    : 'source_http_failed'),
              );
            const result: unknown = await page.evaluate('mw:' + input.script);
            deadline.throwIfAborted();
            if (Buffer.byteLength(JSON.stringify(result) ?? 'null') > 2 * 1024 * 1024)
              throw new Error('source_body_limit');
            const state = await context.storageState();
            const actualAgent = await page.evaluate(() => navigator.userAgent);
            deadline.throwIfAborted();
            if (proxy?.failure === 'source_body_limit') throw new Error(proxy.failure);
            visited.add(initial.origin);
            mergeBrowserSession(
              scope,
              saved,
              state,
              Object.fromEntries([...visited].slice(0, 64).map((origin) => [origin, actualAgent])),
            );
            return result ?? null;
          })(),
          deadline,
        );
      } catch (error) {
        if (deadline.aborted)
          throw new Error(signal.aborted ? 'cancelled' : 'source_request_timeout', { cause: error });
        const message = (error as Error).message;
        const scriptFailure = /(?:^|\n)(?:Error: )?(source_[a-z_]+)(?:$|\n)/.exec(message)?.[1];
        const safe = scriptFailure ?? navigationFailure ?? proxy?.failure ?? message;
        throw new Error(/^source_[a-z_]+$/.test(safe) ? safe : 'source_browser_failed', { cause: error });
      } finally {
        deadline.removeEventListener('abort', close);
      }
    } catch (error) {
      if (deadline.aborted) throw new Error(signal.aborted ? 'cancelled' : 'source_request_timeout', { cause: error });
      throw error;
    } finally {
      if (deadline.aborted && admitted) {
        // Firefox may leave proxy authentication work pending after a cancelled context.
        // Each admitted job owns one browser slot, so discarding it cannot cancel another source.
        const launching = this.browsers.get(engine);
        this.browsers.delete(engine);
        if (browser) await boundedClose(browser.close());
        else void launching?.then((late) => late.close()).catch(() => undefined);
      } else if (context && browser) {
        await this.releaseContext(context, browser, engine);
      }
      proxy?.close();
      this.pending--;
      if (admitted) {
        this.active--;
        this.slots.delete(slot);
        this.scopes.delete(admissionKey);
      }
      notify();
      if (!this.pending) {
        this.idle = setTimeout(
          () => {
            void this.close();
          },
          5 * 60 * 1000,
        );
        this.idle.unref();
      }
    }
  }

  async close() {
    clearTimeout(this.idle);
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((browser) => browser.then((value) => value.close()).catch(() => undefined)));
  }
}

export const sourceWebViewHost = new SourceWebViewHost();
