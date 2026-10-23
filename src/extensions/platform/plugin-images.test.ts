import { expect, it } from 'vitest';
import { PluginHttp } from './plugin-http';
import { setup, approve, single } from './store-test-fixture';
import { inspectSingleJs } from '../packages/platform-single-js';
import { buildPlatformPackage } from '../packages/platform-package';
async function fixture(feature = true, granted = true) {
  const f = setup(),
    source = single(),
    manifest = inspectSingleJs(new Uint8Array(await source.arrayBuffer())).manifest;
  manifest.entries.ui = { path: 'dist/ui.js', permissions: ['ui.render', 'http.request'] };
  manifest.features.required.push('ui.views', 'http.request');
  if (feature) manifest.features.required.push('ui.images');
  manifest.contributes.views = ['gallery'];
  manifest.contributes.connections = ['covers'];
  const blob = await buildPlatformPackage({
    manifest,
    sources: { controller: await source.text(), ui: '// fixture' },
    license: 'MIT',
  });
  const review = await f.store.inspect(blob, 'package', 'file:test');
  const row = await f.store.install(
    review,
    approve(review, granted ? {} : { roles: { controller: ['settings.own'], ui: ['ui.render'] } }),
  );
  const session = await f.store.openSession(row.pluginId, 'ui', row.revision);
  return {
    ...f,
    row,
    session,
    close: async () => {
      await f.store.close();
      await f.peer.close();
    },
  };
}
it.each([
  [false, true],
  [true, false],
])('requires UI image feature and HTTP consent before any transport: %s %s', async (feature, grant) => {
  const f = await fixture(feature, grant);
  let calls = 0;
  const http = new PluginHttp(f.store, 'profile', new AbortController().signal, async () => {
    calls++;
    throw Error('unexpected');
  });
  try {
    await expect(
      http.image(f.session, { slot: 'covers', path: 'a.png' }, new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});
it('binds image requests to UI connection revision and cancels with the dispatched ID', async () => {
  const f = await fixture(),
    calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  const http = new PluginHttp(f.store, 'profile', new AbortController().signal, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/list'))
      return Response.json([{ slot: 'covers', roles: ['ui'], methods: ['GET'], revision: 'rev' }]);
    if (String(url).endsWith('/cancel')) return Response.json({ ok: true });
    ready();
    return new Promise((_r, reject) =>
      init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
    );
  });
  try {
    const abort = new AbortController(),
      pending = http.image(f.session, { slot: 'covers', path: 'a.png' }, abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    await started;
    abort.abort();
    await rejected;
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['list', 'image', 'cancel']);
    expect(calls[1].body).toMatchObject({
      revision: 'rev',
      request: { slot: 'covers', path: 'a.png' },
      owner: { installationId: f.row.installationId, digest: f.row.active },
    });
    expect(calls[2].body.requestId).toBe(calls[1].body.requestId);
  } finally {
    await f.close();
  }
});
