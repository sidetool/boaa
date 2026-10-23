import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  address: '8.8.8.8',
  body: '{}',
  encoding: 'identity',
  status: 200,
  options: undefined as Record<string, unknown> | undefined,
  proxy: vi.fn(),
  destroy: vi.fn(),
  requests: 0,
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: state.address, family: 4 }] }));
vi.mock('../extensions/outbound-proxy', () => ({ pinnedProxyAgent: state.proxy }));
vi.mock('node:https', () => ({
  request: (_url: URL, options: Record<string, unknown>, receive: (res: EventEmitter) => void) => {
    state.requests++;
    state.options = options;
    const req = new EventEmitter();
    return Object.assign(req, {
      end() {
        queueMicrotask(() => {
          let destroyed = false;
          const res = Object.assign(new EventEmitter(), {
            statusCode: state.status,
            headers: { 'content-encoding': state.encoding },
            destroy(error: Error) {
              destroyed = true;
              queueMicrotask(() => res.emit('error', error));
            },
          });
          receive(res);
          if (!destroyed) res.emit('data', Buffer.from(state.body));
          if (!destroyed) res.emit('end');
        });
      },
    });
  },
}));
import { pluginHttpTransport } from './http-transport';
import { pluginCoverTransport } from './cover-transport';
const input = { slot: 'catalog', path: 'list', method: 'GET', response: 'json' } as const;
const send = (proxy?: string, signal = new AbortController().signal) =>
  pluginHttpTransport(
    input,
    'https://catalog.example/api/',
    undefined,
    'https://reader.example',
    [],
    [],
    443,
    signal,
    async () => {},
    proxy,
  );
beforeEach(() => {
  state.proxy.mockReset();
  state.destroy.mockReset();
  state.proxy.mockImplementation((proxy: string | undefined) => (proxy ? { destroy: state.destroy } : undefined));
  Object.assign(state, {
    address: '8.8.8.8',
    body: '{}',
    encoding: 'identity',
    status: 200,
    options: undefined,
    requests: 0,
  });
});
it('pins the validated destination through the operator proxy and disposes its agent', async () => {
  const signal = new AbortController().signal;
  expect(await send('socks5://operator.example:1080', signal)).toMatchObject({ ok: true, status: 200, body: {} });
  expect(state.proxy).toHaveBeenCalledWith(
    'socks5://operator.example:1080',
    new URL('https://catalog.example/api/list'),
    '8.8.8.8',
    signal,
  );
  expect(state.options?.agent).toEqual({ destroy: state.destroy });
  expect(state.destroy).toHaveBeenCalledTimes(1);
});
it('preserves direct mode and never falls back when the proxy configuration fails', async () => {
  await send();
  expect(state.options?.agent).toBe(false);
  state.proxy.mockImplementation(() => {
    throw Error('proxy_failed');
  });
  const requests = state.requests;
  expect(await send('socks5://bad.example:1080')).toMatchObject({ ok: false, outcome: 'not-sent' });
  expect(state.requests).toBe(requests);
});
it('rejects private DNS and pre-aborted calls before creating a proxy connection', async () => {
  state.address = '127.0.0.1';
  expect(await send('socks5://operator.example:1080')).toMatchObject({ ok: false, outcome: 'not-sent' });
  state.address = '8.8.8.8';
  expect(await send('socks5://operator.example:1080', AbortSignal.abort())).toMatchObject({
    ok: false,
    code: 'HTTP_CANCELLED',
  });
  expect(state.proxy).not.toHaveBeenCalled();
  expect(state.requests).toBe(0);
});
it('retains byte/compression/JSON limits and destroys the agent on failed responses', async () => {
  for (const patch of [
    { body: 'x'.repeat(24 * 1024 + 1), encoding: 'identity' },
    { body: '{}', encoding: 'gzip' },
    { body: 'bad-json', encoding: 'identity' },
  ]) {
    Object.assign(state, patch);
    state.destroy.mockClear();
    expect(await send('socks5://operator.example:1080')).toMatchObject({ ok: false, outcome: 'failed' });
    expect(state.destroy).toHaveBeenCalledTimes(1);
  }
});
it('uses the same pinned proxy and cleanup for cover downloads even when content is invalid', async () => {
  await expect(
    pluginCoverTransport(
      'https://art.example/images/a.png',
      'https://art.example/images/',
      'https://reader.example',
      new AbortController().signal,
      async () => {},
      'socks5://operator.example:1080',
    ),
  ).rejects.toThrow('INVALID_COVER');
  expect(state.proxy).toHaveBeenCalledWith(
    'socks5://operator.example:1080',
    new URL('https://art.example/images/a.png'),
    '8.8.8.8',
    expect.any(AbortSignal),
  );
  expect(state.destroy).toHaveBeenCalledTimes(1);
});

it('preserves non-JSON upstream error statuses without relaxing success parsing or byte limits', async () => {
  for (const status of [302, 401, 403, 429, 503]) {
    for (const body of ['', '<html>upstream error</html>']) {
      Object.assign(state, { status, body });
      expect(await send()).toMatchObject({ ok: true, status, body: null });
    }
  }
  Object.assign(state, { status: 429, body: JSON.stringify({ error: 'limited' }) });
  expect(await send()).toMatchObject({ ok: true, status: 429, body: { error: 'limited' } });
  Object.assign(state, { status: 403, body: 'x'.repeat(24 * 1024 + 1) });
  expect(await send()).toMatchObject({ ok: false, code: 'HTTP_FAILED' });
});
