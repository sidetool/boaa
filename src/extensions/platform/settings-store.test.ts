import { afterEach, expect, it } from 'vitest';
import { setup, install, id, schema, single, approve } from './store-test-fixture';
import type { PlatformPluginStore } from './plugin-store';
const stores: PlatformPluginStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function fixture() {
  const f = setup();
  stores.push(f.store, f.peer);
  const row = await install(f.store);
  const session = await f.store.openSession(id, 'controller', row.revision);
  const other = await f.peer.openSession(id, 'controller', row.revision);
  return { ...f, row, session, other };
}
it('registers defaults once, preserves user values, and serializes cross-window CAS updates', async () => {
  const { store, peer, session, other } = await fixture();
  const first = await store.registerSettings(session, schema);
  expect(first).toMatchObject({ revision: 1, value: { color: '#123456', enabled: true } });
  const results = await Promise.allSettled([
    store.writeConfig(session, { schema, expectedRevision: 1, value: { ...first.value, color: '#abcdef' } }),
    peer.writeConfig(other, { schema, expectedRevision: 1, value: { ...first.value, color: '#654321' } }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFIG_CONFLICT' } });
  const saved = await store.readConfig(session);
  expect(saved?.revision).toBe(2);
  expect(await store.registerSettings(session, schema)).toEqual(saved);
  expect(await peer.readConfig(other)).toEqual(saved);
});
it('rejects invalid values and schema changes without mutating saved state', async () => {
  const { store, session } = await fixture();
  const first = await store.registerSettings(session, schema);
  await expect(
    store.writeConfig(session, { schema, expectedRevision: 1, value: { enabled: 'yes', color: '#123456' } }),
  ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  const changed = { ...schema, version: 2 };
  await expect(store.registerSettings(session, changed)).rejects.toMatchObject({ code: 'CONFIG_MIGRATION_REQUIRED' });
  await expect(
    store.writeConfig(session, { schema: changed, expectedRevision: 1, value: first.value }),
  ).rejects.toMatchObject({ code: 'CONFIG_MIGRATION_REQUIRED' });
  expect(await store.readConfig(session)).toEqual(first);
});
it('atomically migrates config with an approved package update and rolls back through another reviewed migration', async () => {
  const { store, row, session } = await fixture();
  const first = await store.registerSettings(session, schema);
  const update = await store.inspect(single('2.0.0'), 'single-js', 'file:plugin');
  const preserve = { data: 'preserve' as const, allowUnsignedDataReuse: true };
  await expect(store.install(update, approve(update, preserve))).rejects.toMatchObject({
    code: 'CONFIG_REVIEW_REQUIRED',
  });
  const nextSchema = { ...schema, version: 2 };
  await expect(
    store.install(
      update,
      approve(update, { ...preserve, config: { schema: nextSchema, expectedRevision: 1, value: { enabled: 0 } } }),
    ),
  ).rejects.toThrow();
  expect((await store.list())[0].active).toBe(row.active);
  expect(await store.readConfig(session)).toEqual(first);
  const updated = await store.install(
    update,
    approve(update, {
      ...preserve,
      config: { schema: nextSchema, expectedRevision: 1, value: { ...first.value, color: '#abcdef' } },
    }),
  );
  expect(updated.installationId).toBe(row.installationId);
  await expect(store.readConfig(session)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
  const current = await store.openSession(id, 'controller', updated.revision);
  expect(await store.registerSettings(current, nextSchema)).toMatchObject({ revision: 2, value: { color: '#abcdef' } });
  const rollback = await store.inspectRetained(id, 'previous');
  await expect(store.install(rollback, approve(rollback, preserve))).rejects.toMatchObject({
    code: 'DOWNGRADE_REVIEW_REQUIRED',
  });
  const restored = await store.install(
    rollback,
    approve(rollback, {
      ...preserve,
      allowDowngrade: true,
      config: { schema, expectedRevision: 2, value: first.value },
    }),
  );
  expect(restored.active).toBe(row.active);
  expect(await store.inspectConfig(id, restored.revision)).toMatchObject({ revision: 3, schema, value: first.value });
});
it('rejects a prepared migration when another window changes settings or revokes installation', async () => {
  const { store, peer, row, session, other } = await fixture();
  const first = await store.registerSettings(session, schema);
  const review = await store.inspect(single('2.0.0'), 'single-js', 'file:plugin');
  await peer.writeConfig(other, { schema, expectedRevision: 1, value: { ...first.value, enabled: false } });
  await expect(
    store.install(
      review,
      approve(review, {
        data: 'preserve',
        allowUnsignedDataReuse: true,
        config: { schema, expectedRevision: 1, value: first.value },
      }),
    ),
  ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
  expect((await store.readConfig(session))?.value.enabled).toBe(false);
  expect((await store.list())[0].active).toBe(row.active);
  await peer.disable(id, row.revision);
  await expect(store.writeConfig(session, { schema, expectedRevision: 2, value: first.value })).rejects.toMatchObject({
    code: 'PACKAGE_GENERATION_CHANGED',
  });
});
it('does not retain a stale session after explicit retirement', async () => {
  const { store, session } = await fixture();
  await store.registerSettings(session, schema);
  store.closeSession(session);
  await expect(
    store.writeConfig(session, { schema, expectedRevision: 1, value: { color: '#000000', enabled: false } }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it('fences user settings edits by installation/config revision, schema and shutdown', async () => {
  const { store, row, session } = await fixture();
  const first = await store.registerSettings(session, schema);
  await expect(
    store.writeHostConfig(id, row.revision, { schema, expectedRevision: 1, value: { ...first.value, enabled: false } }),
  ).resolves.toMatchObject({ revision: 2 });
  await expect(
    store.writeHostConfig(id, row.revision, { schema, expectedRevision: 1, value: first.value }),
  ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
  await expect(
    store.writeHostConfig(id, row.revision, {
      schema: { ...schema, version: 2 },
      expectedRevision: 2,
      value: first.value,
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_MIGRATION_REQUIRED' });
  await store.disable(id, row.revision);
  await expect(
    store.writeHostConfig(id, row.revision, { schema, expectedRevision: 2, value: first.value }),
  ).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' });
  store.suspend();
  await expect(
    store.writeHostConfig(id, row.revision + 1, { schema, expectedRevision: 2, value: first.value }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
