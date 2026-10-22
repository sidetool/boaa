import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticSourceRequest } from './source-browser-auto.js';
import { sourceBrowserRouteMemory } from './source-browser-route-memory.js';
import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';
import { EncryptedSourceCredentialVault, SessionSourceCredentialVault } from './source-credential-vault.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const input = { url: 'https://fixture.example/catalog?page=1' };
const ok = { statusCode: 200, url: input.url, headers: {} };
const denied = { ...ok, statusCode: 403, headers: { 'cf-mitigated': 'challenge' } };
const scope = (): SourceWebViewScope => ({
  key: JSON.stringify(['fixture', 'browser:source', crypto.randomUUID()]),
  browserAllowed: true,
  vault: new SessionSourceCredentialVault(),
  routeRevision: 'v1',
});
const signal = () => new AbortController().signal;

it('uses HTTP by default without consulting the browser for successful or ordinary denied reads', async () => {
  const browser = vi.fn();
  const refresh = vi.spyOn(sourceWebViewHost, 'evaluate');
  for (const statusCode of [200, 401, 403, 500]) {
    const response = { ...ok, statusCode };
    expect(await automaticSourceRequest(input, scope(), signal(), async () => response, browser)).toBe(response);
  }
  expect(browser).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it('learns only a successful browser fallback and skips HTTP/auth for the next page', async () => {
  const current = scope();
  const refresh = vi.spyOn(sourceWebViewHost, 'evaluate').mockResolvedValue(null);
  const http = vi.fn(async () => denied);
  const browser = vi.fn(async () => ok);
  const discard = vi.fn();
  expect(await automaticSourceRequest(input, current, signal(), http, browser, discard)).toBe(ok);
  expect(http).toHaveBeenCalledTimes(2);
  expect(discard).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
  expect(
    await automaticSourceRequest(
      { url: input.url.replace('page=1', 'page=2') },
      { ...current },
      signal(),
      http,
      browser,
    ),
  ).toBe(ok);
  expect(http).toHaveBeenCalledTimes(2);
  expect(browser).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
});

it('keeps HTTP when refreshed cookies work instead of learning a browser preference', async () => {
  const current = scope();
  vi.spyOn(sourceWebViewHost, 'evaluate').mockResolvedValue(null);
  const http = vi.fn().mockResolvedValueOnce(denied).mockResolvedValue(ok);
  const browser = vi.fn();
  await automaticSourceRequest(input, current, signal(), http, browser);
  await automaticSourceRequest(input, current, signal(), http, browser);
  expect(http).toHaveBeenCalledTimes(3);
  expect(browser).not.toHaveBeenCalled();
  expect(sourceBrowserRouteMemory(input, current).prefersBrowser()).toBe(false);
});

it('restores learned routes from an encrypted vault and reprobes HTTP after a fixed expiry', async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'boaa-route-memory-'));
  try {
    const key = Buffer.alloc(32, 7);
    const current = { ...scope(), vault: new EncryptedSourceCredentialVault(root, key) };
    sourceBrowserRouteMemory(input, current).remember();
    const reopened = { ...current, vault: new EncryptedSourceCredentialVault(root, key) };
    const http = vi.fn(async () => ok),
      browser = vi.fn(async () => ok);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await automaticSourceRequest(input, reopened, signal(), http, browser);
    expect(http).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    await automaticSourceRequest(input, reopened, signal(), http, browser);
    expect(http).toHaveBeenCalledOnce();
    expect(browser).toHaveBeenCalledOnce();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('isolates path, representation, source, proxy, extension revision and engine without changing permissions', async () => {
  const current = scope();
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'patchright');
  sourceBrowserRouteMemory(input, current).remember();
  for (const other of [
    { ...input, url: 'https://fixture.example/content' },
    { ...input, url: 'https://other.example/catalog?page=1' },
    { ...input, headers: { Accept: 'application/json' } },
  ])
    expect(sourceBrowserRouteMemory(other, current).prefersBrowser()).toBe(false);
  for (const other of [
    { ...current, key: JSON.stringify(['other', 'browser:source', 'epoch']) },
    { ...current, vault: new SessionSourceCredentialVault() },
    { ...current, outboundProxy: 'socks5://127.0.0.1:1080' },
    { ...current, routeRevision: 'v2' },
  ])
    expect(sourceBrowserRouteMemory(input, other).prefersBrowser()).toBe(false);
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'camoufox');
  expect(sourceBrowserRouteMemory(input, current).prefersBrowser()).toBe(false);
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'patchright');
  const browser = vi.fn();
  const http = vi.fn(async () => denied);
  for (const other of [
    { ...current, browserUsage: 'off' as const },
    { ...current, browserAllowed: false },
  ])
    await automaticSourceRequest(input, other, signal(), http, browser);
  await automaticSourceRequest({ ...input, method: 'POST', body: 'mutation' }, current, signal(), http, browser);
  expect(http).toHaveBeenCalledTimes(3);
  expect(browser).not.toHaveBeenCalled();
});

it('falls back to HTTP and forgets a learned route if the browser is removed', async () => {
  const current = scope();
  sourceBrowserRouteMemory(input, current).remember();
  const browser = vi.fn().mockRejectedValue(new Error('source_browser_unavailable'));
  const http = vi.fn(async () => ok);
  await automaticSourceRequest(input, current, signal(), http, browser);
  await automaticSourceRequest(input, current, signal(), http, browser);
  expect(browser).toHaveBeenCalledOnce();
  expect(http).toHaveBeenCalledTimes(2);
});

it('never learns a failed or cancelled browser response and does not bypass security errors', async () => {
  vi.spyOn(sourceWebViewHost, 'evaluate').mockResolvedValue(null);
  const current = scope();
  const http = vi.fn(async () => denied);
  await automaticSourceRequest(input, current, signal(), http, async () => denied);
  expect(sourceBrowserRouteMemory(input, current).prefersBrowser()).toBe(false);
  await automaticSourceRequest(input, current, signal(), http, async () => ({ ...denied, statusCode: 200 }));
  expect(sourceBrowserRouteMemory(input, current).prefersBrowser()).toBe(false);
  const controller = new AbortController(),
    discard = vi.fn();
  await expect(
    automaticSourceRequest(
      input,
      current,
      controller.signal,
      http,
      async () => {
        controller.abort();
        return ok;
      },
      discard,
    ),
  ).rejects.toThrow();
  expect(sourceBrowserRouteMemory(input, current).prefersBrowser()).toBe(false);
  expect(discard).toHaveBeenCalledWith(ok);
  sourceBrowserRouteMemory(input, current).remember();
  http.mockClear();
  await expect(
    automaticSourceRequest(input, current, signal(), http, async () => {
      throw new Error('source_url_denied');
    }),
  ).rejects.toThrow('source_url_denied');
  expect(http).not.toHaveBeenCalled();
});

it('bounds persistent hints and evicts old paths without keeping browser processes alive', () => {
  const current = scope();
  for (let i = 0; i < 65; i++) sourceBrowserRouteMemory({ url: `https://fixture.example/${i}` }, current).remember();
  expect(sourceBrowserRouteMemory({ url: 'https://fixture.example/0' }, current).prefersBrowser()).toBe(false);
  expect(sourceBrowserRouteMemory({ url: 'https://fixture.example/64' }, current).prefersBrowser()).toBe(true);
});
