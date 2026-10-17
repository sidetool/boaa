import { afterEach, expect, it } from 'vitest';
import { UiPluginStore } from './plugin-store';
import { id, setup, install, packageFixture, approve, preserve } from './store-test-fixture';
const stores: UiPluginStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function fixture(archive?: Blob) {
  const f = setup();
  stores.push(f.store, f.peer);
  await install(f.store, archive);
  return { ...f, session: await f.store.openSession(id), other: await f.peer.openSession(id) };
}
it('CAS conflicts across two connections; retry is idempotent and changed payload is rejected', async () => {
  const { store, peer, session, other } = await fixture();
  const params = { key: 'k', value: { b: 2, a: 1 }, expectedRevision: null, idempotencyKey: 'write-a' };
  const a = await store.storage(session, 'storage.set', params);
  expect(await peer.storage(other, 'storage.set', { ...params, value: { a: 1, b: 2 } })).toEqual(a);
  await expect(store.storage(session, 'storage.set', { ...params, value: 'different' })).rejects.toMatchObject({
    code: 'STORAGE_CONFLICT',
  });
  const writes = await Promise.allSettled([
    store.storage(session, 'storage.set', {
      key: 'k',
      value: 'one',
      expectedRevision: a.revision,
      idempotencyKey: 'one',
    }),
    peer.storage(other, 'storage.set', { key: 'k', value: 'two', expectedRevision: a.revision, idempotencyKey: 'two' }),
  ]);
  expect(writes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  expect(writes.find((v) => v.status === 'rejected')).toMatchObject({ reason: { code: 'STORAGE_CONFLICT' } });
});
it('does not reuse value revisions after delete/recreate and persists retry receipts across reload', async () => {
  const { store, peer, session, other } = await fixture();
  const create = { key: 'k', value: 'one', expectedRevision: null, idempotencyKey: 'create' };
  const first = await store.storage(session, 'storage.set', create);
  await store.close();
  expect(await peer.storage(other, 'storage.set', create)).toEqual(first);
  const removed = await peer.storage(other, 'storage.remove', {
    key: 'k',
    expectedRevision: first.revision,
    idempotencyKey: 'remove',
  });
  const next = await peer.storage(other, 'storage.set', { ...create, idempotencyKey: 'new' });
  expect(next.revision).toBeGreaterThan(removed.revision);
  await expect(
    peer.storage(other, 'storage.set', { ...create, expectedRevision: first.revision, idempotencyKey: 'stale' }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
});
it('revocation prevents new reads/writes including old retry receipts; before-commit write remains saved', async () => {
  const { store, peer, session } = await fixture();
  const params = { key: 'k', value: 'before', expectedRevision: null, idempotencyKey: 'a' };
  await store.storage(session, 'storage.set', params);
  await peer.revoke(id, 1);
  await expect(store.storage(session, 'storage.set', params)).rejects.toMatchObject({
    code: 'PACKAGE_GENERATION_CHANGED',
  });
  await expect(store.storage(session, 'storage.get', { key: 'k' })).rejects.toMatchObject({
    code: 'PACKAGE_GENERATION_CHANGED',
  });
  const review = await peer.inspectInstalled(id);
  await peer.install(review, approve(review, preserve));
  expect(await peer.storage(await peer.openSession(id), 'storage.get', { key: 'k' })).toMatchObject({
    value: 'before',
  });
});
it('scope/session invalidation while hashing prevents the pending write from reaching the database', async () => {
  const { store, session } = await fixture();
  const pending = store.storage(session, 'storage.set', {
    key: 'k',
    value: 'late',
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  store.closeSession(session);
  await expect(pending).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(await store.storage(await store.openSession(id), 'storage.get', { key: 'k' })).toEqual({ found: false });
});
it('enforces value/envelope and namespace quotas atomically without retaining failed rows or receipts', async () => {
  const { store, session } = await fixture(await packageFixture('1.0.0', { storageKiB: 4 }));
  const first = await store.storage(session, 'storage.set', {
    key: 'k',
    value: 'saved',
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  await expect(
    store.storage(session, 'storage.set', {
      key: 'big',
      value: 'x'.repeat(4000),
      expectedRevision: null,
      idempotencyKey: 'b',
    }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(await store.storage(session, 'storage.get', { key: 'big' })).toEqual({ found: false });
  const second = await store.storage(session, 'storage.set', {
    key: 'small',
    value: 'ok',
    expectedRevision: null,
    idempotencyKey: 'b',
  });
  expect(second.revision).toBe(first.revision + 1);
  await expect(
    store.storage(session, 'storage.set', {
      key: 'oversize',
      value: '한'.repeat(22000),
      expectedRevision: null,
      idempotencyKey: 'c',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});
it('retains recent receipts instead of silently evicting them, and reclaims expired receipt quota', async () => {
  const { store, session, advance } = await fixture();
  let revision: number | null = null;
  for (let i = 0; i < 128; i++)
    revision = (
      await store.storage(session, 'storage.set', {
        key: 'k',
        value: i,
        expectedRevision: revision,
        idempotencyKey: `r${i}`,
      })
    ).revision;
  await expect(
    store.storage(session, 'storage.set', { key: 'k', value: 129, expectedRevision: revision, idempotencyKey: 'full' }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  advance(300001);
  const next = await store.storage(session, 'storage.set', {
    key: 'k',
    value: 129,
    expectedRevision: revision,
    idempotencyKey: 'full',
  });
  expect(next.revision).toBe(129);
});
it('paginates by response bytes and binds cursors to session, prefix and a stable namespace revision', async () => {
  const { store, peer, session, other } = await fixture();
  for (let i = 0; i < 6; i++)
    await store.storage(session, 'storage.set', {
      key: `k${i}`,
      value: 'x'.repeat(50000),
      expectedRevision: null,
      idempotencyKey: `r${i}`,
    });
  const page = await store.storage(session, 'storage.list', { limit: 100, prefix: 'k' });
  expect(page.items.length).toBeGreaterThan(0);
  expect(page.items.length).toBeLessThan(6);
  expect(page.nextCursor).toBeDefined();
  await expect(
    peer.storage(other, 'storage.list', { limit: 100, prefix: 'k', cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await expect(
    store.storage(session, 'storage.list', { limit: 100, prefix: 'different', cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  const rest = await store.storage(session, 'storage.list', { limit: 100, prefix: 'k', cursor: page.nextCursor! });
  expect([...page.items, ...rest.items].map((i) => i.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  await store.storage(session, 'storage.set', {
    key: 'k6',
    value: 'new',
    expectedRevision: null,
    idempotencyKey: 'new',
  });
  await expect(
    store.storage(session, 'storage.list', { limit: 100, prefix: 'k', cursor: page.nextCursor! }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });
});
it('rejects an update that lowers quota below retained data; installation and data remain unchanged', async () => {
  const { store, session } = await fixture();
  await store.storage(session, 'storage.set', {
    key: 'large',
    value: 'x'.repeat(5000),
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  const review = await store.inspect(await packageFixture('2.0.0', { storageKiB: 1 }), 'local-file:fixture');
  await expect(store.install(review, approve(review, preserve))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect((await store.list())[0].revision).toBe(1);
  expect(await store.storage(session, 'storage.get', { key: 'large' })).toMatchObject({ found: true });
});

it('can traverse more than 128 pages without exhausting cursor slots', async () => {
  const { store, session, advance } = await fixture();
  for (let i = 0; i < 140; i++) {
    if (i === 100) advance(300001);
    await store.storage(session, 'storage.set', {
      key: `page-${String(i).padStart(3, '0')}`,
      value: i,
      expectedRevision: null,
      idempotencyKey: `page-${i}`,
    });
  }
  const protectedSession = await store.openSession(id);
  const protectedPage = await store.storage(protectedSession, 'storage.list', { limit: 1 });
  const first = await store.storage(session, 'storage.list', { limit: 1 });
  const keys = first.items.map((row) => row.key);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await store.storage(session, 'storage.list', { limit: 1, cursor });
    keys.push(...page.items.map((row) => row.key));
    cursor = page.nextCursor;
  }
  expect(keys).toEqual(Array.from({ length: 140 }, (_, i) => `page-${String(i).padStart(3, '0')}`));
  // Older positions in this session can expire early, but another session keeps its cursor.
  await expect(store.storage(session, 'storage.list', { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  expect(
    (await store.storage(protectedSession, 'storage.list', { limit: 1, cursor: protectedPage.nextCursor! })).items.map(
      (row) => row.key,
    ),
  ).toEqual(['page-001']);
});

it('reuses next-page positions on retries without extending their expiry', async () => {
  const { store, session, advance } = await fixture();
  for (const key of ['a', 'b', 'c']) {
    await store.storage(session, 'storage.set', { key, value: key, expectedRevision: null, idempotencyKey: key });
  }
  const first = await store.storage(session, 'storage.list', { limit: 1 });
  advance(300000 - 1);
  for (let i = 0; i < 140; i++) {
    expect(await store.storage(session, 'storage.list', { limit: 1 })).toEqual(first);
  }
  advance(1);
  await expect(store.storage(session, 'storage.list', { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  const refreshed = await store.storage(session, 'storage.list', { limit: 1 });
  expect(refreshed.nextCursor).not.toBe(first.nextCursor);
  expect(
    (await store.storage(session, 'storage.list', { limit: 1, cursor: refreshed.nextCursor! })).items.map(
      (row) => row.key,
    ),
  ).toEqual(['b']);
});
