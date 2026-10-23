import { expect, it } from 'vitest';
import { setup, id, approve } from './store-test-fixture';
async function source(version = '1.0.0', storageKiB = 1) {
  return new Blob([
    `/* @boaa-plugin ${JSON.stringify({ id, version, apiVersion: 2, license: 'MIT', activation: ['onAppSession'], permissions: ['storage.own'], features: ['storage.own'], contributes: {}, storageKiB })} */`,
  ]);
}
it('enforces permission, CAS, quota and stable revisions across removal; lists keys without values', async () => {
  const { store } = setup(),
    review = await store.inspect(await source(), 'single-js', 'local-file');
  const row = await store.install(review, approve(review)),
    session = await store.openSession(id, 'controller', row.revision);
  const first = await store.storageSet(session, { key: 'a', value: 'one', expectedRevision: null });
  await expect(
    store.storageSet(session, { key: 'a', value: 'conflict', expectedRevision: null }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
  await expect(
    store.storageSet(session, { key: 'large', value: 'x'.repeat(1024), expectedRevision: null }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(await store.storageList(session, { limit: 1 })).toEqual({ items: [{ key: 'a', revision: first.revision }] });
  await store.storageRemove(session, { key: 'a', expectedRevision: first.revision });
  const second = await store.storageSet(session, { key: 'a', value: 'two', expectedRevision: null });
  expect(second.revision).toBeGreaterThan(first.revision);
  await expect(
    store.storageSet(session, { key: 'a', value: 'stale', expectedRevision: first.revision }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
  const restricted = await store.inspect(await source('2.0.0'), 'single-js', 'local-file');
  const next = await store.install(restricted, approve(restricted, { roles: { controller: [] } }));
  const denied = await store.openSession(id, 'controller', next.revision);
  await expect(store.storageGet(denied, { key: 'a' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await store.close();
});
it('preserves data only on reviewed reuse, resets it on replacement and deletes it on uninstall', async () => {
  const { store } = setup(),
    review = await store.inspect(await source(), 'single-js', 'local-file');
  const one = await store.install(review, approve(review)),
    session = await store.openSession(id, 'controller', one.revision);
  await store.storageSet(session, { key: 'cache', value: 1, expectedRevision: null });
  const update = await store.inspect(await source('2.0.0'), 'single-js', 'local-file');
  const two = await store.install(update, approve(update, { data: 'preserve', allowUnsignedDataReuse: true }));
  const next = await store.openSession(id, 'controller', two.revision);
  expect(await store.storageGet(next, { key: 'cache' })).toMatchObject({ found: true, value: 1 });
  const reset = await store.inspect(await source('3.0.0'), 'single-js', 'local-file');
  const three = await store.install(reset, approve(reset));
  expect(await store.storageGet(await store.openSession(id, 'controller', three.revision), { key: 'cache' })).toEqual({
    found: false,
  });
  await store.disable(id, three.revision, true);
  const reinstall = await store.inspect(await source('4.0.0'), 'single-js', 'local-file');
  const four = await store.install(reinstall, approve(reinstall));
  expect(await store.storageList(await store.openSession(id, 'controller', four.revision), { limit: 128 })).toEqual({
    items: [],
  });
  await store.close();
});
it('bounds list payloads for Unicode keys and returns all keys through pagination', async () => {
  const { store } = setup(),
    review = await store.inspect(await source('1.0.0', 128), 'single-js', 'local-file');
  const row = await store.install(review, approve(review)),
    session = await store.openSession(id, 'controller', row.revision);
  for (let i = 0; i < 128; i++)
    await store.storageSet(session, {
      key: String(i).padStart(3, '0') + '한'.repeat(125),
      value: null,
      expectedRevision: null,
    });
  const first = await store.storageList(session, { limit: 128 });
  expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(48 * 1024);
  expect(first.nextCursor).toBeTruthy();
  const second = await store.storageList(session, { limit: 128, cursor: first.nextCursor });
  expect([...first.items, ...second.items]).toHaveLength(128);
  await store.close();
});
it('releases the live-install quota when removing plugins while retaining removal records', async () => {
  const { store } = setup();
  for (let i = 0; i < 129; i++) {
    const file = new Blob([(await (await source()).text()).split(id).join(`org.example.quota${i}`)]);
    const review = await store.inspect(file, 'single-js', 'local-file'),
      row = await store.install(review, approve(review));
    await store.disable(row.pluginId, row.revision, true);
  }
  expect((await store.list()).filter((row) => row.tombstone)).toHaveLength(129);
  await store.close();
});
