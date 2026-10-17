import { afterEach, expect, it, vi } from 'vitest';
import { PluginHttp } from './plugin-http';
import { setup, approve } from './store-test-fixture';
import { inspectSingleJs } from '../packages/platform-single-js';
const header = {
  id: 'org.example.http',
  version: '1.0.0',
  apiVersion: 2,
  license: 'MIT',
  activation: ['onAppSession'],
  permissions: ['http.request'],
  features: ['http.request'],
  contributes: { connections: ['backend'] },
};
const source = new Blob([
  `/* @boaa-plugin ${JSON.stringify(header)} */\nBoaaPlugin.register({apiVersion:2,activate(){}});`,
]);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture(granted = true) {
  const { store, peer } = setup();
  const review = await store.inspect(source, 'single-js', 'file:test');
  const row = await store.install(review, approve(review, granted ? {} : { roles: { controller: [] } }));
  const session = await store.openSession(row.pluginId, 'controller', row.revision),
    life = new AbortController();
  return { store, peer, row, session, life, http: new PluginHttp(store, crypto.randomUUID(), life.signal) };
}
it('single JS requires explicit feature and connection slots', () => {
  const encode = (h: unknown) => new TextEncoder().encode(`/* @boaa-plugin ${JSON.stringify(h)} */\nvoid 0;`);
  expect(inspectSingleJs(encode(header)).manifest.contributes.connections).toEqual(['backend']);
  expect(() => inspectSingleJs(encode({ ...header, features: [] }))).toThrow();
  expect(() => inspectSingleJs(encode({ ...header, contributes: {} }))).toThrow();
});
it('denies ungranted guest network without contacting server', async () => {
  const f = await fixture(false),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(
      f.http.request(
        f.session,
        { slot: 'backend', path: '', method: 'GET', response: 'json' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await f.store.close();
    await f.peer.close();
  }
});
it('binds owner and role on host, never accepts an arbitrary URL or unknown slot', async () => {
  const f = await fixture();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ url, body });
      return Response.json(
        url.endsWith('/list')
          ? [{ slot: 'backend', roles: ['controller'], revision: 'rev' }]
          : { ok: true, status: 200, headers: {}, body: { answer: 42 } },
      );
    }),
  );
  try {
    expect(
      await f.http.request(
        f.session,
        { slot: 'backend', path: 'items', method: 'GET', response: 'json' },
        f.life.signal,
      ),
    ).toMatchObject({ ok: true, body: { answer: 42 } });
    expect(calls[1].body).toMatchObject({
      role: 'controller',
      owner: { installationId: f.row.installationId, digest: f.row.active, generation: f.row.revision },
      revision: 'rev',
    });
    await expect(
      f.http.request(f.session, { slot: 'other', path: '', method: 'GET', response: 'text' }, f.life.signal),
    ).rejects.toThrow();
    await expect(
      f.http.request(
        f.session,
        { slot: 'backend', path: '', method: 'GET', response: 'text', url: 'https://evil.test' },
        f.life.signal,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  } finally {
    await f.store.close();
    await f.peer.close();
  }
});
it('cancels a controller request by its own id and reports possible write completion without retry', async () => {
  const f = await fixture();
  const calls: string[] = [];
  let started!: () => void;
  const sent = new Promise<void>((r) => {
    started = r;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/list')) return Response.json([{ slot: 'backend', roles: ['controller'], revision: 'rev' }]);
      if (url.endsWith('/cancel')) return Response.json({ ok: true });
      started();
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
      );
    }),
  );
  try {
    const waiting = f.http.controller(
      f.session,
      'http.request',
      { id: 1, request: { slot: 'backend', path: 'items', method: 'POST', response: 'json', body: '{}' } },
      f.life.signal,
    );
    await sent;
    await f.http.controller(f.session, 'http.cancel', { id: 1 }, f.life.signal);
    expect(await waiting).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(calls.filter((u) => u.endsWith('/request'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/cancel'))).toHaveLength(1);
  } finally {
    await f.store.close();
    await f.peer.close();
  }
});
it('cross-tab disable aborts the pending request and invalidates later authority', async () => {
  const f = await fixture();
  let started!: () => void;
  const sent = new Promise<void>((r) => {
    started = r;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/list')) return Response.json([{ slot: 'backend', roles: ['controller'], revision: 'rev' }]);
      if (url.endsWith('/cancel')) return Response.json({ ok: true });
      started();
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
      );
    }),
  );
  try {
    const waiting = f.http.request(
      f.session,
      { slot: 'backend', path: 'items', method: 'POST', response: 'json' },
      f.life.signal,
    );
    await sent;
    await f.peer.disable(f.row.pluginId, f.row.revision);
    expect(await waiting).toMatchObject({ ok: false, outcome: 'unknown' });
    await expect(
      f.http.request(f.session, { slot: 'backend', path: '', method: 'GET', response: 'json' }, f.life.signal),
    ).rejects.toThrow();
  } finally {
    await f.store.close();
    await f.peer.close();
  }
});
