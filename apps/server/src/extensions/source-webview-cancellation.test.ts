import type { Browser } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceWebViewHost } from './source-webview.js';
import * as browserLaunch from './source-browser-launch.js';

vi.mock('./source-browser-proxy.js', () => ({
  openSourceBrowserProxy: vi.fn(async () => ({
    proxy: { server: 'http://127.0.0.1:1' },
    bootstrapUrl: 'http://boaa-browser.invalid/test',
    close: vi.fn(),
  })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('does not launch for a cancelled request after an idle browser finishes closing', async () => {
  let finishClose!: () => void;
  const browser = {
    close: () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  } as unknown as Browser;
  const host = new SourceWebViewHost();
  (host as unknown as { browsers: Map<string, Promise<Browser>> }).browsers.set(
    `${process.env.BOAA_BROWSER_ENGINE || (process.env.BOAA_CAMOUFOX_EXECUTABLE || process.env.BOAA_SOURCE_BROWSER_ENDPOINT ? 'camoufox' : 'patchright')}:0`,
    Promise.resolve(browser),
  );
  const launch = vi.spyOn(browserLaunch, 'launchSourceBrowser').mockRejectedValue(new Error('unexpected launch'));
  const retiring = host.close();
  await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
  const abort = new AbortController();
  const pending = host.evaluate(
    { url: 'https://source.example/', script: 'true' },
    { key: 'cancelled-during-idle-close', origins: ['https://source.example'] },
    abort.signal,
  );
  // Let admission finish while the old process is still retiring.
  await Promise.resolve();
  const result = expect(pending).rejects.toThrow('cancelled');
  abort.abort();
  finishClose();
  await retiring;
  await result;
  await host.close();
  expect(launch).not.toHaveBeenCalled();
});

it('returns cancellation and discards the browser when navigation and context shutdown both stall', async () => {
  vi.useFakeTimers();
  const goto = vi.fn(() => new Promise<never>(() => {}));
  const context = {
    routeWebSocket: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue({ on: vi.fn(), goto }),
    close: vi.fn(() => new Promise<never>(() => {})),
  };
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = { newContext: vi.fn().mockResolvedValue(context), close } as unknown as Browser;
  const host = new SourceWebViewHost();
  vi.spyOn(host as unknown as { launch(engine: string): Promise<Browser> }, 'launch').mockResolvedValue(browser);
  const abort = new AbortController();
  const pending = host.evaluate(
    { url: 'https://source.example/', script: 'true' },
    {
      key: 'synthetic-stall',
      origins: ['https://source.example'],
      browserMode: 'camoufox',
    },
    abort.signal,
  );
  await vi.waitFor(() => expect(goto).toHaveBeenCalled());
  const result = expect(pending).rejects.toThrow('cancelled');
  abort.abort();
  await vi.advanceTimersByTimeAsync(2100);
  await result;
  expect(close).toHaveBeenCalledOnce();
  await host.close();
});
