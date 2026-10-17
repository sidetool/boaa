import { afterEach, expect, it } from 'vitest';
import { setup, single, id, approve, install, scope, schema, composite } from './store-test-fixture';
import { UiPluginStore } from '../ui/plugin-store';
const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
function fixture(now?: () => number) {
  const f = setup(now);
  stores.push(f.store, f.peer);
  return f;
}
const preserve = { data: 'preserve' as const, allowUnsignedDataReuse: true };
it('inspects, installs and reloads exact single JS without executing it or requiring a panel', async () => {
  const { store } = fixture();
  const payload = single();
  const review = await store.inspect(payload, 'single-js', 'file:plugin');
  expect(await store.list()).toEqual([]);
  await expect(store.install(structuredClone(review), approve(review))).rejects.toMatchObject({
    code: 'REVIEW_EXPIRED',
  });
  await expect(store.install(review, approve(review, { digest: 'wrong' }))).rejects.toMatchObject({
    code: 'APPROVAL_MISMATCH',
  });
  review.manifest.extension.id = 'org.evil.forged';
  const row = await store.install(review, approve(review));
  expect(row.pluginId).toBe(id);
  const session = await store.openSession(id, 'controller', row.revision);
  expect(await store.loadEntry(session)).toBe(await payload.text());
  expect(session.fence.digest).toBe(review.digest);
  await expect(store.openSession(id, 'ui', row.revision)).rejects.toThrow();
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
});
it('serializes competing installations and expires reviews without writing state', async () => {
  let now = 0;
  const { store, peer } = fixture(() => now);
  const a = await store.inspect(single(), 'single-js', 'file:plugin');
  const b = await peer.inspect(single(), 'single-js', 'file:plugin');
  const results = await Promise.allSettled([store.install(a, approve(a)), peer.install(b, approve(b))]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'INSTALL_CONFLICT' } });
  const review = await store.inspect(single('2.0.0'), 'single-js', 'file:plugin');
  now += 300001;
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
  expect((await store.list())[0].revision).toBe(1);
});
it('requires per-role grants and checks all fence fields plus the method allowlist', async () => {
  const { store, peer } = fixture();
  const review = await store.inspect(await composite(), 'package', 'file:plugin');
  await expect(store.install(review, approve(review, { roles: { ui: ['settings.own'] } }))).rejects.toMatchObject({
    code: 'PERMISSION_DENIED',
  });
  const row = await store.install(review, approve(review));
  const controller = await store.openSession(id, 'controller', row.revision);
  const ui = await store.openSession(id, 'ui', row.revision);
  expect(await store.loadEntry(ui)).toBe('// ui');
  await expect(store.readConfig(ui)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  for (const key of Object.keys(controller.fence)) {
    const fence = { ...controller.fence, [key]: key === 'generation' ? 999 : 'forged' };
    await expect(store.assertSession(controller, fence)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  }
  await expect(store.assertSession({ ...controller }, controller.fence)).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  await expect(peer.assertSession(controller, controller.fence)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await store.assertCall(controller, controller.fence, 'settings.get');
  for (const method of [
    'fetch',
    'ctx.request',
    '__proto__',
    'constructor',
    'toString',
    'reader.content.visible',
    'storage.get',
  ])
    await expect(store.assertCall(controller, controller.fence, method)).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
    });
  const task = await store.openSession(id, 'task', row.revision);
  await store.assertCall(controller, controller.fence, 'tasks.run');
  await expect(store.assertCall(ui, ui.fence, 'tasks.run')).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
  await expect(store.assertCall(controller, controller.fence, 'settings.watch')).rejects.toMatchObject({
    code: 'METHOD_NOT_ALLOWED',
  });
  await expect(store.assertCall(task, task.fence, 'settings.get')).rejects.toMatchObject({
    code: 'METHOD_NOT_ALLOWED',
  });
  await peer.disable(id, row.revision);
  await expect(store.assertCall(controller, controller.fence, 'tasks.run')).rejects.toMatchObject({
    code: 'PACKAGE_GENERATION_CHANGED',
  });
  await expect(store.loadEntry(controller)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
});
it('does not share V2 DB, approval, config, scope or window authority', async () => {
  const { store, peer, factory, name } = fixture();
  const old = new UiPluginStore(scope, { factory, name });
  stores.push(old);
  const row = await install(store);
  expect(await old.list()).toEqual([]);
  const a = await store.openSession(id, 'controller', row.revision);
  const b = await peer.openSession(id, 'controller', row.revision);
  expect(a.fence.windowSessionId).not.toBe(b.fence.windowSessionId);
  await store.registerSettings(a, schema);
  store.changeScope({ ...scope, accountId: 'bob' });
  expect(await store.list()).toEqual([]);
  await expect(store.readConfig(a)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await expect(store.inspectConfig(id, row.revision)).rejects.toThrow();
  expect((await peer.readConfig(b))?.value.color).toBe('#123456');
  await store.close();
  await expect(store.list()).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it('retains role markers after faults and only cleans them through teardown or explicit disabled recovery', async () => {
  const { store, peer } = fixture();
  const row = await install(store);
  const a = await store.openSession(id, 'controller', row.revision);
  await store.startMarker(a);
  await expect(store.startMarker(a)).rejects.toMatchObject({ code: 'DUPLICATE_INSTANCE' });
  expect(await peer.unfinishedMarkers()).toMatchObject([{ role: 'controller', fence: a.fence }]);
  const cleanup = store.retireSession(a);
  await expect(store.assertSession(a, a.fence)).rejects.toThrow();
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  await cleanup();
  expect(await peer.unfinishedMarkers()).toEqual([]);
  const b = await store.openSession(id, 'controller', row.revision);
  await store.startMarker(b);
  store.closeSession(b);
  await expect(peer.acknowledgeMarkers(id, row.revision)).rejects.toThrow();
  await peer.disable(id, row.revision);
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  await peer.acknowledgeMarkers(id, row.revision + 1);
  expect(await peer.unfinishedMarkers()).toEqual([]);
});
it('keeps settings readable without code while disabled and re-enables through fresh review', async () => {
  const { store } = fixture();
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  await store.registerSettings(session, schema);
  await store.disable(id, row.revision);
  expect((await store.inspectConfig(id, row.revision + 1))?.schema).toEqual(schema);
  await expect(store.openSession(id, 'controller', row.revision + 1)).rejects.toThrow();
  const review = await store.inspectRetained(id, 'active');
  const enabled = await store.install(review, approve(review, preserve));
  expect(enabled.installationId).toBe(row.installationId);
  const current = await store.openSession(id, 'controller', enabled.revision);
  expect((await store.readConfig(current))?.revision).toBe(1);
});
it('requires publisher review and never preserves data across a publisher switch', async () => {
  const { store } = fixture();
  const sign = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const first = await store.inspect(await composite(await sign()), 'package', 'file:plugin');
  await store.install(first, approve(first));
  const other = await store.inspect(await composite(await sign(), '2.0.0'), 'package', 'file:plugin');
  await expect(store.install(other, approve(other))).rejects.toMatchObject({ code: 'PUBLISHER_REVIEW_REQUIRED' });
  await expect(store.install(other, approve(other, { ...preserve, allowPublisherChange: true }))).rejects.toMatchObject(
    { code: 'DATA_REUSE_REQUIRES_REVIEW' },
  );
  await store.install(other, approve(other, { allowPublisherChange: true }));
});
it('requires fresh review for same-version replacement and unsigned provenance changes', async () => {
  const { store } = fixture();
  await install(store);
  const changed = await store.inspect(single('1.0.0', '//changed'), 'single-js', 'file:plugin');
  await expect(store.install(changed, approve(changed))).rejects.toMatchObject({ code: 'VERSION_REVIEW_REQUIRED' });
  await store.install(changed, approve(changed, { allowSameVersionReplacement: true }));
  const elsewhere = await store.inspect(single('2.0.0'), 'single-js', 'file:other');
  await expect(store.install(elsewhere, approve(elsewhere, preserve))).rejects.toMatchObject({
    code: 'DATA_REUSE_REQUIRES_REVIEW',
  });
});
it('removes config/payloads and rejects stale installation reviews', async () => {
  const { store, peer } = fixture();
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  await store.registerSettings(session, schema);
  const update = await store.inspect(single('2.0.0'), 'single-js', 'file:plugin');
  await peer.disable(id, row.revision, true);
  await expect(store.install(update, approve(update))).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' });
  await expect(store.inspectRetained(id, 'active')).rejects.toThrow();
  const review = await store.inspect(single(), 'single-js', 'file:plugin');
  const next = await store.install(review, approve(review));
  expect(next.installationId).not.toBe(row.installationId);
  expect(await store.inspectConfig(id, next.revision)).toBeUndefined();
});
it('does not borrow another role’s settings permission even with a UI/controller composite package', async () => {
  const { store } = fixture();
  const review = await store.inspect(await composite(), 'package', 'file:plugin');
  const row = await store.install(review, approve(review, { roles: { controller: [], ui: ['ui.render'] } }));
  const session = await store.openSession(id, 'controller', row.revision);
  expect(await store.loadEntry(session)).toContain('Never run');
  await expect(store.registerSettings(session, schema)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});
it('rejects review results when the account changes during verification', async () => {
  const { store } = fixture();
  const pending = store.inspect(single(), 'single-js', 'file:plugin');
  store.changeScope({ ...scope, accountId: 'other' });
  await expect(pending).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(await store.list()).toEqual([]);
});
it('allows a UI-only package to register its own settings without creating a controller role', async () => {
  const { store } = fixture();
  const { buildPlatformPackage } = await import('../packages/platform-package');
  const { inspectSingleJs } = await import('../packages/platform-single-js');
  const manifest = inspectSingleJs(new Uint8Array(await single().arrayBuffer())).manifest;
  manifest.entries = { ui: { path: 'dist/ui.js', permissions: ['ui.render', 'settings.own'] } };
  manifest.features.required = ['ui.views', 'settings.schema'];
  manifest.activation = ['onView'];
  manifest.contributes.views = ['settings'];
  const review = await store.inspect(
    await buildPlatformPackage({ manifest, sources: { ui: '//not evaluated' }, license: 'MIT' }),
    'package',
    'file:plugin',
  );
  const row = await store.install(review, approve(review));
  const ui = await store.openSession(id, 'ui', row.revision);
  await store.assertCall(ui, ui.fence, 'settings.register');
  expect((await store.registerSettings(ui, schema)).value.enabled).toBe(true);
  await expect(store.openSession(id, 'controller', row.revision)).rejects.toThrow();
});
it('uses an opaque fence scope token instead of exposing account and library identifiers', async () => {
  const { store } = fixture();
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  expect(session.fence.scopeId).not.toBe(row.scope);
  expect(session.fence.scopeId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(session.fence)).not.toContain('alice');
  await store.assertSession(session, session.fence);
});
it('denies direct task configuration access even if its manifest requested settings permission', async () => {
  const { store } = fixture();
  const { buildPlatformPackage } = await import('../packages/platform-package');
  const { inspectSingleJs } = await import('../packages/platform-single-js');
  const manifest = inspectSingleJs(new Uint8Array(await single().arrayBuffer())).manifest;
  manifest.entries.task = { path: 'dist/task.js', permissions: ['settings.own'] };
  const review = await store.inspect(
    await buildPlatformPackage({ manifest, sources: { controller: '//controller', task: '//task' }, license: 'MIT' }),
    'package',
    'file:plugin',
  );
  const row = await store.install(review, approve(review));
  const task = await store.openSession(id, 'task', row.revision);
  await expect(store.readConfig(task)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(
    store.writeConfig(task, { schema, expectedRevision: 0, value: { color: '#123456', enabled: true } }),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});
