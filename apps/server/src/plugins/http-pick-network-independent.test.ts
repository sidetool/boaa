import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PluginHttpRequest } from '../../../../packages/extension-contracts/plugin-http';
const state = vi.hoisted(() => ({
  body: Buffer.from('{}'),
  status: 200,
  encoding: 'identity',
  sent: 0,
  headers: {} as Record<string, string>,
  checks: 0,
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '8.8.8.8', family: 4 }] }));
vi.mock('../extensions/outbound-proxy', () => ({ pinnedProxyAgent: () => undefined }));
vi.mock('node:https', () => ({
  request: (_url: URL, options: { headers: Record<string, string> }, receive: (res: EventEmitter) => void) => {
    state.sent++;
    state.headers = options.headers;
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
          for (let i = 0; i < state.body.length && !destroyed; i += 8192)
            res.emit('data', state.body.subarray(i, i + 8192));
          if (!destroyed) res.emit('end');
        });
      },
    });
  },
}));
import { pluginHttpTransport } from './http-transport';
const base: PluginHttpRequest = { slot: 'api', path: 'list', method: 'GET', response: 'json', pick: [['keep']] };
const send = (
  patch: Partial<PluginHttpRequest> = {},
  allowedHeaders: string[] = [],
  signal = new AbortController().signal,
) =>
  pluginHttpTransport(
    { ...base, ...patch },
    'https://catalog.example/api/',
    undefined,
    'https://reader.example',
    [],
    allowedHeaders,
    443,
    signal,
    async () => {
      state.checks++;
    },
  );
const bytes = (size: number) =>
  Buffer.from(
    JSON.stringify({
      keep: 'yes',
      discard: 'x'.repeat(size - Buffer.byteLength(JSON.stringify({ keep: 'yes', discard: '' }))),
    }),
  );
beforeEach(() => {
  Object.assign(state, { body: Buffer.from('{}'), status: 200, encoding: 'identity', sent: 0, headers: {}, checks: 0 });
});
it('accepts exactly512KiB raw only with pick while rejecting +1 and unchanged no-pick24KiB', async () => {
  state.body = bytes(512 * 1024);
  expect(state.body.length).toBe(512 * 1024);
  expect(await send()).toMatchObject({ ok: true, body: { keep: 'yes' } });
  expect(state.checks).toBe(2);
  state.body = bytes(512 * 1024 + 1);
  expect((await send()) as { ok: boolean }).toHaveProperty('ok', false);
  state.body = bytes(24 * 1024);
  expect(((await send({ pick: undefined })) as { ok: boolean }).ok).toBe(true);
  state.body = bytes(24 * 1024 + 1);
  expect(((await send({ pick: undefined })) as { ok: boolean }).ok).toBe(false);
});
it('limits selected UTF8 body at exactly24KiB without borrowing56KiB RPC allowance', async () => {
  state.body = Buffer.from(JSON.stringify({ keep: '가'.repeat(8188) + 'x' }));
  expect(state.body.length).toBe(24 * 1024);
  expect(((await send()) as { ok: boolean }).ok).toBe(true);
  state.body = Buffer.from(JSON.stringify({ keep: '가'.repeat(8188) + 'xx' }));
  expect(((await send()) as { ok: boolean }).ok).toBe(false);
});
it('retains non2xx status without projection and keeps its raw cap, successful JSON strictness and encoding checks', async () => {
  for (const status of [302, 401, 403, 429, 503]) {
    state.status = status;
    for (const body of ['', '<html>challenge</html>']) {
      state.body = Buffer.from(body);
      expect(await send()).toMatchObject({ ok: true, status, body: null });
    }
    state.body = Buffer.from('{"error":"denied"}');
    expect(await send()).toMatchObject({ ok: true, status, body: { error: 'denied' } });
  }
  state.status = 403;
  state.body = bytes(24 * 1024 + 1);
  expect(((await send()) as { ok: boolean }).ok).toBe(false);
  state.status = 200;
  state.body = Buffer.from('malformed');
  expect(((await send()) as { ok: boolean }).ok).toBe(false);
  state.body = Buffer.from('{}');
  state.encoding = 'gzip';
  expect(((await send()) as { ok: boolean }).ok).toBe(false);
});
it('allows only connection-approved exact target origin and rejects invalid inputs before dispatch', async () => {
  state.body = Buffer.from('{"keep":true}');
  expect(((await send({ headers: { origin: 'https://catalog.example' } }, ['origin'])) as { ok: boolean }).ok).toBe(
    true,
  );
  expect(state.headers.origin).toBe('https://catalog.example');
  for (const value of [
    'https://reader.example',
    'https://catalog.example/',
    'https://catalog.example/api/',
    'https://catalog.example:8443',
    'null',
    'https://other.example',
  ]) {
    const count = state.sent;
    expect(((await send({ headers: { origin: value } }, ['origin'])) as { ok: boolean }).ok).toBe(false);
    expect(state.sent).toBe(count);
  }
  const count = state.sent;
  expect(((await send({ headers: { origin: 'https://catalog.example' } })) as { ok: boolean }).ok).toBe(false);
  expect(((await send({ response: 'text' })) as { ok: boolean }).ok).toBe(false);
  expect(((await send({ pick: [] })) as { ok: boolean }).ok).toBe(false);
  expect(((await send({}, [], AbortSignal.abort())) as { ok: boolean }).ok).toBe(false);
  expect(state.sent).toBe(count);
});
