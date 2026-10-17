import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { UiPluginStore } from './plugin-store';
import { scope, id, setup, install, packageFixture, approve, preserve } from './store-test-fixture';
import { UI_STORE_LIMITS } from './store-model';
const stores: UiPluginStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
});
function fixture() {
  const f = setup();
  stores.push(f.store, f.peer);
  return f;
}
async function database(factory: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function rows(factory: IDBFactory, name: string, table: string) {
  const db = await database(factory, name);
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction(table).objectStore(table).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
it('keeps exactly active/previous archives, reclaims data on removal and preserves tombstone revision', async () => {
  const { store, factory, name } = fixture();
  await install(store);
  const session = await store.openSession(id);
  await store.storage(session, 'storage.set', { key: 'k', value: 'data', expectedRevision: null, idempotencyKey: 'a' });
  for (const version of ['2.0.0', '3.0.0']) {
    const review = await store.inspect(await packageFixture(version), 'local-file:fixture');
    await store.install(review, approve(review, preserve));
  }
  expect(await rows(factory, name, 'archives')).toHaveLength(2);
  await store.remove(id, 3);
  for (const table of ['archives', 'grants', 'kv', 'receipts'])
    expect(await rows(factory, name, table)).toHaveLength(0);
  expect(await rows(factory, name, 'usage')).toEqual([
    { id: 'profile', installations: 1, dataBytes: 0, archiveBytes: 0 },
  ]);
  expect((await store.list())[0]).toMatchObject({ revision: 4, tombstone: true });
});
it('counts keys and receipt metadata, not just user value bytes, and limits small-key floods', async () => {
  const { store, advance } = fixture();
  await install(store);
  const session = await store.openSession(id);
  for (let i = 0; i < 1000; i++) {
    if (i % 100 === 0) advance(300001);
    await store.storage(session, 'storage.set', {
      key: `k${i}`,
      value: null,
      expectedRevision: null,
      idempotencyKey: `r${i}`,
    });
  }
  advance(300001);
  await expect(
    store.storage(session, 'storage.set', {
      key: 'overflow',
      value: null,
      expectedRevision: null,
      idempotencyKey: 'new',
    }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(await store.storage(session, 'storage.get', { key: 'overflow' })).toEqual({ found: false });
  const review = await store.inspect(await packageFixture('2.0.0'), 'local-file:fixture');
  expect(review.currentDataBytes).toBeGreaterThan(100000);
}, 20000);
it('enforces profile quota against existing allocation and aborts the whole write', async () => {
  const { store, factory, name } = fixture();
  await install(store);
  const session = await store.openSession(id);
  // Simulate quota already occupied by other namespaces, without allocating 32 MiB in every unit test.
  const db = await database(factory, name);
  await new Promise<void>((resolve) => {
    const tx = db.transaction('usage', 'readwrite');
    const s = tx.objectStore('usage');
    const req = s.get('profile');
    req.onsuccess = () => s.put({ ...req.result, dataBytes: UI_STORE_LIMITS.profileBytes - 1 });
    tx.oncomplete = () => resolve();
  });
  db.close();
  await expect(
    store.storage(session, 'storage.set', { key: 'k', value: 1, expectedRevision: null, idempotencyKey: 'a' }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(await rows(factory, name, 'kv')).toHaveLength(0);
  expect(await rows(factory, name, 'receipts')).toHaveLength(0);
});
it('does not fall back to memory when IndexedDB open or transaction writes fail', async () => {
  const factory = {
    open() {
      throw new Error('denied');
    },
  } as unknown as IDBFactory;
  const denied = new UiPluginStore(scope, { factory });
  stores.push(denied);
  await expect(denied.list()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  const { store, factory: normal, name } = fixture();
  await install(store);
  const session = await store.openSession(id);
  const original = FakeObjectStore.prototype.put;
  const spy = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (
    this: InstanceType<typeof FakeObjectStore>,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'receipts') throw new DOMException('simulated disk quota', 'QuotaExceededError');
    return original.call(this, value, key);
  });
  await expect(
    store.storage(session, 'storage.set', { key: 'k', value: 1, expectedRevision: null, idempotencyKey: 'a' }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  spy.mockRestore();
  expect(await rows(normal, name, 'kv')).toEqual([]);
  expect(await rows(normal, name, 'receipts')).toEqual([]);
  expect(await store.storage(session, 'storage.get', { key: 'k' })).toEqual({ found: false });
});
it('simultaneous revoke and write has a serial result and never reports an uncommitted value', async () => {
  const { store, peer } = fixture();
  await install(store);
  const session = await store.openSession(id);
  const pending = store.storage(session, 'storage.set', {
    key: 'raced',
    value: 42,
    expectedRevision: null,
    idempotencyKey: 'r',
  });
  const outcomes = await Promise.allSettled([pending, peer.revoke(id, 1)]);
  expect(outcomes[1].status).toBe('fulfilled');
  const review = await peer.inspect(await packageFixture(), 'local-file:fixture');
  await peer.install(review, approve(review, preserve));
  const result = await peer.storage(await peer.openSession(id), 'storage.get', { key: 'raced' });
  expect(result.found).toBe(outcomes[0].status === 'fulfilled');
});

it('archive quota failure rolls back a requested reset and leaves the active version and data intact', async () => {
  const { store, factory, name } = fixture();
  await install(store);
  const session = await store.openSession(id);
  await store.storage(session, 'storage.set', {
    key: 'saved',
    value: 'keep',
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  const db = await database(factory, name);
  await new Promise<void>((resolve) => {
    const tx = db.transaction('usage', 'readwrite');
    const s = tx.objectStore('usage');
    const req = s.get('profile');
    req.onsuccess = () => s.put({ ...req.result, archiveBytes: UI_STORE_LIMITS.archiveBytes });
    tx.oncomplete = () => resolve();
  });
  db.close();
  const review = await store.inspect(await packageFixture('2.0.0'), 'local-file:fixture');
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect((await store.list())[0].manifest?.extension.version).toBe('1.0.0');
  expect(await store.storage(session, 'storage.get', { key: 'saved' })).toMatchObject({ value: 'keep' });
  expect(await rows(factory, name, 'archives')).toHaveLength(1);
});
