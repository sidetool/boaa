import { afterEach, expect, it, vi } from 'vitest';
import { sourceBrowserHttp } from './source-browser-cookies.js';
import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';
import { writeBrowserSession } from './source-browser-session.js';
import type { compatibilityHttp } from './mangayomi/http.js';

afterEach(() => vi.restoreAllMocks());
const url = 'https://source.example/document';
const response = (statusCode = 200, challenge = false) => ({
  url,
  statusCode,
  headers: challenge ? { 'cf-mitigated': 'challenge' } : {},
  bytes: Buffer.from('synthetic'),
  contentType: 'text/html',
});
const scope = (usage?: SourceWebViewScope['browserUsage']): SourceWebViewScope => ({
  key: crypto.randomUUID(),
  browserAllowed: true,
  browserUsage: usage,
});

it('defaults to HTTP without installation or launch, including challenge and permission responses', async () => {
  const evaluate = vi.spyOn(sourceWebViewHost, 'evaluate').mockRejectedValue(new Error('must not launch'));
  const browserRequest = vi.spyOn(sourceWebViewHost, 'request').mockRejectedValue(new Error('must not launch'));
  for (const current of [scope(), scope('off'), { ...scope('always'), browserAllowed: false }]) {
    for (const status of [200, 401, 403]) {
      const result = response(status, status === 403);
      await expect(
        sourceBrowserHttp({ url }, AbortSignal.timeout(1000), current, 1024, async () => result),
      ).resolves.toBe(result);
    }
  }
  expect(evaluate).not.toHaveBeenCalled();
  expect(browserRequest).not.toHaveBeenCalled();
});

it('refreshes a recognized read challenge once and then reuses saved cookies through HTTP', async () => {
  const entries = new Map<string, { secret: string }>();
  const current = {
    ...scope('http-first'),
    vault: {
      read: (key: string) => entries.get(key),
      write: (key: string, value?: { secret: string }) => {
        if (value) entries.set(key, value);
      },
    },
  };
  const evaluate = vi.spyOn(sourceWebViewHost, 'evaluate').mockImplementation(async () => {
    writeBrowserSession(current, {
      cookies: [
        {
          name: 'session',
          value: 'synthetic',
          domain: 'source.example',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [],
      userAgents: { 'https://source.example': 'Browser identity' },
    });
    return null;
  });
  const transport = vi.fn<typeof compatibilityHttp>(async (input) =>
    input.headers?.cookie === 'session=synthetic' ? response() : response(403, true),
  );
  const result = await sourceBrowserHttp({ url }, AbortSignal.timeout(1000), current, 1024, transport);
  expect(result.statusCode).toBe(200);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1][0].headers).toMatchObject({
    cookie: 'session=synthetic',
    'user-agent': 'Browser identity',
  });
  await sourceBrowserHttp({ url }, AbortSignal.timeout(1000), current, 1024, transport);
  expect(evaluate).toHaveBeenCalledOnce();
});

it('does not turn ordinary denials or non-idempotent requests into browser authentication', async () => {
  const evaluate = vi.spyOn(sourceWebViewHost, 'evaluate').mockRejectedValue(new Error('must not launch'));
  for (const [method, challenge] of [
    ['GET', false],
    ['POST', true],
    ['PUT', true],
  ] as const) {
    await sourceBrowserHttp({ url, method }, AbortSignal.timeout(1000), scope('http-first'), 1024, async () =>
      response(403, challenge),
    );
  }
  expect(evaluate).not.toHaveBeenCalled();
});

it('coalesces authentication and keeps it alive when only one of two readers cancels', async () => {
  let finish!: () => void;
  let sharedSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const evaluate = vi.spyOn(sourceWebViewHost, 'evaluate').mockImplementation(async (_input, _scope, signal) => {
    sharedSignal = signal;
    await gate;
    return null;
  });
  const current = scope('http-first');
  const abort = new AbortController();
  const transport = async () => response(403, true);
  const first = sourceBrowserHttp({ url }, abort.signal, current, 1024, transport);
  const rejected = expect(first).rejects.toThrow('cancelled');
  const second = sourceBrowserHttp({ url }, AbortSignal.timeout(2000), current, 1024, transport);
  await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());
  abort.abort();
  await rejected;
  expect(sharedSignal?.aborted).toBe(false);
  finish();
  expect((await second).statusCode).toBe(403);
  expect(evaluate).toHaveBeenCalledOnce();
});

it('routes always mode through browser networking only when the host grants it', async () => {
  const current = scope('always');
  const expected = response();
  const browser = vi.spyOn(sourceWebViewHost, 'request').mockResolvedValue(expected);
  const transport = vi.fn<typeof compatibilityHttp>();
  const input = { url, method: 'POST', body: 'query=synthetic' };
  expect(await sourceBrowserHttp(input, AbortSignal.timeout(2000), current, 1024, transport, true)).toBe(expected);
  expect(browser).toHaveBeenCalledWith(input, current, expect.any(AbortSignal), 1024, true);
  expect(transport).not.toHaveBeenCalled();
});

it('keeps the HTTP response when optional authentication is not installed', async () => {
  vi.spyOn(sourceWebViewHost, 'evaluate').mockRejectedValue(new Error('source_browser_unavailable'));
  const expected = response(403, true);
  expect(
    await sourceBrowserHttp({ url }, AbortSignal.timeout(1000), scope('http-first'), 1024, async () => expected),
  ).toBe(expected);
});
