import { openSourceBrowserProxy } from './source-browser-proxy.js';
import { sourceBrowserLimits } from './source-browser-limits.js';
import { readBrowserSession, mergeBrowserSession } from './source-browser-session.js';
import { launchSourceBrowser, sourceBrowserHasQueuedClients } from './source-browser-launch.js';
import { firefox, type Browser, type BrowserContext } from 'playwright-core';
import type { CompatibilityHttpInput, compatibilityHttp } from './mangayomi/http.js';
import { compatibilityHttpPolicy } from './mangayomi/http-options.js';
import type { SourceBrowserUsage } from './source-browser-mode.js';
import { requestInSourceBrowser } from './source-browser-http-transport.js';
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
  browserUsage?: SourceBrowserUsage;
  /** Host capability, never supplied by a source's HTTP arguments. */
  browserAllowed?: boolean;
  /** Host-only refreshes close before returning to ordinary HTTP. */
  authenticationOnly?: boolean;
  /** Image discovery may load a whole chapter before its collector returns URLs. */
  purpose?: 'image-pages';
}

/** One lazily launched browser, with isolated short-lived contexts and bounded idle reuse. */
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
  private pending = 0;
  private active = 0;
  private scopes = new Set<string>();
  private slots = new Set<number>();
  private wake = new Set<() => void>();
  private shutdowns = new WeakMap<Browser, Promise<void>>();
  private uses = new WeakMap<Browser, number>();
  private retiring: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private queueCheck?: ReturnType<typeof setTimeout>;
  private idleGeneration = 0;
  constructor(
    private readonly options: {
      idleMs?: number;
      maxUses?: number;
      queueCheckMs?: number;
      hasQueuedClients?: () => Promise<boolean>;
    } = {},
  ) {}

  private stopIdle() {
    clearTimeout(this.idle);
    clearTimeout(this.queueCheck);
    this.idleGeneration++;
  }

  private scheduleIdle() {
    if (this.active || !this.browsers.size) return;
    this.stopIdle();
    const generation = this.idleGeneration;
    this.idle = setTimeout(() => {
      void this.close();
    }, this.options.idleMs ?? 60_000);
    this.idle.unref();
    const check = async () => {
      // A warm API connection must not occupy the sole remote process slot
      // while a metadata client is waiting. Never interrupt an active operation.
      const queued = await (this.options.hasQueuedClients ?? sourceBrowserHasQueuedClients)().catch(() => true);
      if (this.active || generation !== this.idleGeneration) return;
      if (queued) {
        void this.close();
        return;
      }
      this.queueCheck = setTimeout(() => {
        void check();
      }, this.options.queueCheckMs ?? 1000);
      this.queueCheck.unref();
    };
    this.queueCheck = setTimeout(() => {
      void check();
    }, this.options.queueCheckMs ?? 1000);
    this.queueCheck.unref();
  }

  private disposeBrowser(browser: Browser) {
    let closing = this.shutdowns.get(browser);
    if (!closing) {
      closing = Promise.resolve()
        .then(() => browser.close())
        .catch(() => undefined);
      this.shutdowns.set(browser, closing);
    }
    return closing;
  }

  private async releaseContext(context: BrowserContext, browser: Browser, engine: string) {
    if (await boundedClose(context.close())) return;
    // A stalled proxy connection can make context close hang. Discard that connection before admitting reuse.
    if ((await this.browsers.get(engine)?.catch(() => undefined)) === browser) this.browsers.delete(engine);
    void this.disposeBrowser(browser);
  }

  private async launch(engine: string, signal?: AbortSignal): Promise<Browser> {
    await this.retiring;
    signal?.throwIfAborted();
    const cached = await this.browsers.get(engine)?.catch(() => undefined);
    signal?.throwIfAborted();
    if (cached && !cached.isConnected()) this.browsers.delete(engine);
    if (!this.browsers.has(engine)) {
      const launching = launchSourceBrowser(firefox, [], process.platform, 'camoufox', signal).catch((error) => {
        if (this.browsers.get(engine) === launching) this.browsers.delete(engine);
        throw new Error('source_browser_unavailable', { cause: error });
      });
      this.browsers.set(engine, launching);
    }
    const browser = await this.browsers.get(engine)!;
    if (!browser.isConnected()) {
      this.browsers.delete(engine);
      throw new Error('source_browser_unavailable');
    }
    return browser;
  }

  async evaluate(input: SourceWebViewRequest, scope: SourceWebViewScope, signal: AbortSignal): Promise<unknown> {
    return this.run(input, scope, signal);
  }

  /** Browser networking selected by the owner's per-source policy, preserving raw response bytes. */
  async request(
    input: CompatibilityHttpInput,
    scope: SourceWebViewScope,
    signal: AbortSignal,
    maximum: number,
    followRedirects: boolean,
  ) {
    if (
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method ?? 'GET') ||
      (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256 * 1024)) ||
      new URL(input.url).hash
    )
      throw new Error('source_http_failed');
    const policy = compatibilityHttpPolicy(input.options);
    return (await this.run(
      {
        url: input.url,
        headers: input.headers,
        script: 'null',
        timeoutMs: Math.max(100, policy.timeoutMs),
      },
      scope,
      signal,
      { input, maximum, followRedirects: followRedirects && policy.followRedirects },
    )) as Awaited<ReturnType<typeof compatibilityHttp>>;
  }

  private async run(
    input: SourceWebViewRequest,
    scope: SourceWebViewScope,
    signal: AbortSignal,
    http?: { input: CompatibilityHttpInput; maximum: number; followRedirects: boolean },
  ): Promise<unknown> {
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
    let successful = false;
    const notify = () => {
      for (const next of [...this.wake]) next();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (deadline.aborted) {
            cleanup();
            reject(new Error(signal.aborted ? 'cancelled' : 'source_request_timeout'));
          } else if (this.active < 1 && !this.scopes.has(admissionKey)) {
            this.stopIdle();
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
      browser = await beforeDeadline(this.launch(engine, deadline), deadline);
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
        const savedNames = new Set(
          (await beforeDeadline(context.cookies(input.url), deadline)).map((cookie) => cookie.name),
        );
        const cookies = suppliedHeaders.cookie.split(';').flatMap((part) => {
          const index = part.indexOf('=');
          return index > 0 && !savedNames.has(part.slice(0, index).trim())
            ? [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: initial.origin + '/' }]
            : [];
        });
        await beforeDeadline(context.addCookies(cookies), deadline);
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
                // Document transport does not need images or media.
                if (http && ['image', 'media'].includes(request.resourceType()) && !request.isNavigationRequest()) {
                  await route.abort('failed');
                  return;
                }
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
            let result: unknown;
            if (http) {
              result = await requestInSourceBrowser(page, http.input, http.maximum, http.followRedirects, permitted);
            } else {
              let response = await page.goto(input.url, {
                waitUntil: input.waitUntil ?? 'domcontentloaded',
                timeout: 0,
              });
              if ([403, 503].includes(response?.status() ?? 0)) {
                let committed: Promise<unknown> | undefined;
                response = await page
                  .waitForResponse(
                    (res) => {
                      if (!res.request().isNavigationRequest() || res.frame() !== page.mainFrame() || !res.ok())
                        return false;
                      // Register at response headers, before this navigation commits.
                      // A same-URL reload otherwise still reports the old document loaded.
                      committed = page.waitForEvent('framenavigated', {
                        predicate: (frame) => frame === page.mainFrame(),
                        timeout: 10000,
                      });
                      return true;
                    },
                    { timeout: 10000 },
                  )
                  .catch(() => response!);
                if (response?.ok()) {
                  // Response headers arrive before a same-URL challenge reload commits.
                  // Waiting on the old document's load state alone can run maker JS
                  // in a context that is about to be destroyed.
                  await committed;
                  await page.waitForLoadState(input.waitUntil ?? 'domcontentloaded', { timeout: 10000 });
                }
              }
              if (!response?.ok())
                throw new Error(
                  navigationFailure ??
                    proxy?.failure ??
                    (response?.status() === 401 || response?.status() === 403
                      ? 'source_access_denied'
                      : 'source_http_failed'),
                );
              result = await page.evaluate('mw:' + input.script);
            }
            deadline.throwIfAborted();
            if (!http && Buffer.byteLength(JSON.stringify(result) ?? 'null') > 2 * 1024 * 1024)
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
            successful = true;
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
      this.pending--;
      if (admitted) {
        const launching = this.browsers.get(engine);
        const releaseSlot = () => {
          this.active--;
          this.slots.delete(slot);
          this.scopes.delete(admissionKey);
          notify();
          this.scheduleIdle();
        };
        let contextClosed = false;
        if (successful && !deadline.aborted && context)
          await boundedClose(
            context.close().then(() => {
              contextClosed = true;
            }),
          );
        proxy?.close();
        const uses = browser ? (this.uses.get(browser) ?? 0) + 1 : 0;
        if (browser) this.uses.set(browser, uses);
        if (
          successful &&
          !deadline.aborted &&
          contextClosed &&
          browser?.isConnected() &&
          !scope.authenticationOnly &&
          // Firefox can retain memory after context.close(). Bound continuous
          // browsing as well as idle time, without reopening for every request.
          uses < (this.options.maxUses ?? 8) &&
          (this.options.idleMs ?? 60_000) > 0
        ) {
          releaseSlot();
        } else {
          const cleanup = (
            browser ? this.disposeBrowser(browser) : launching?.then((late) => this.disposeBrowser(late))
          )?.catch(() => undefined);
          this.retiring = Promise.all([this.retiring, cleanup]).then(() => {});
          const released = this.retiring.finally(() => {
            if (this.browsers.get(engine) === launching) this.browsers.delete(engine);
            releaseSlot();
          });
          // Cancellation returns promptly, but a closing process retains its slot.
          await boundedClose(released);
        }
      } else proxy?.close();
    }
  }

  async close() {
    this.stopIdle();
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    this.retiring = Promise.all([
      this.retiring,
      ...browsers.map((browser) => browser.then((value) => this.disposeBrowser(value)).catch(() => undefined)),
    ]).then(() => {});
    await this.retiring;
  }
}

export const sourceWebViewHost = new SourceWebViewHost();
