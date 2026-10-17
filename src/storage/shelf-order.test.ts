import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createLibraryShelf,
  listLibraryShelves,
  reorderLibraryShelves,
  updateLibraryShelf,
} from './library-management-store';
import { resetReaderDbForTests } from './reader-database';
import { listSyncOutbox } from './sync-event-store';

beforeEach(() => resetReaderDbForTests());
afterEach(() => vi.restoreAllMocks());
const order = (shelves: Awaited<ReturnType<typeof listLibraryShelves>>) =>
  shelves.map(({ id, revision }) => ({ id, expectedRevision: revision }));
async function seed() {
  await createLibraryShelf({ name: 'A', color: '#abcdef' });
  await createLibraryShelf({ name: 'B' });
  return listLibraryShelves();
}
it('commits a complete order and matching sync events, preserving metadata', async () => {
  const before = await seed();
  const events = await listSyncOutbox();
  const result = await reorderLibraryShelves(order([...before].reverse()));
  expect(result.map((shelf) => shelf.id)).toEqual([before[1].id, before[0].id]);
  expect(await listLibraryShelves()).toEqual(result);
  expect(result.map((shelf) => shelf.sortOrder)).toEqual([0, 1]);
  expect(result[1]).toMatchObject({ ...before[0], sortOrder: 1, revision: 2, updatedAt: expect.any(String) });
  expect((await listSyncOutbox()).slice(events.length).map((row) => row.event.payload)).toEqual(
    result.map((shelf) => ({ shelf })),
  );
});
it('repairs tied ranks in the requested order', async () => {
  const before = await seed();
  await updateLibraryShelf(before[1].id, { sortOrder: 0 });
  const shelves = await listLibraryShelves();
  const result = await reorderLibraryShelves(order([...shelves].reverse()));
  expect(result.map((shelf) => [shelf.id, shelf.sortOrder])).toEqual([
    [before[1].id, 0],
    [before[0].id, 1],
  ]);
});
it.each([0, 1])('rolls back shelf writes and outbox on write %i failure', async (failure) => {
  const before = await seed();
  const events = await listSyncOutbox();
  const original = IDBObjectStore.prototype.put;
  let writes = 0;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (this.name === 'shelves' && writes++ === failure) throw new Error('injected write failure');
    return original.apply(this, args);
  });
  await expect(reorderLibraryShelves(order([...before].reverse()))).rejects.toThrow('injected');
  expect(await listLibraryShelves()).toEqual(before);
  expect(await listSyncOutbox()).toEqual(events);
});
it('rejects stale revisions, missing and duplicate shelves without any writes', async () => {
  const before = await seed();
  const events = await listSyncOutbox();
  for (const invalid of [
    order(before).map((item, index) => ({ ...item, expectedRevision: index ? 99 : 1 })),
    order(before).slice(0, 1),
    [order(before)[0], order(before)[0]],
  ]) {
    await expect(reorderLibraryShelves(invalid)).rejects.toThrow('변경');
    expect(await listLibraryShelves()).toEqual(before);
    expect(await listSyncOutbox()).toEqual(events);
  }
});
it('allows an empty library and fences concurrent reorders', async () => {
  expect(await reorderLibraryShelves([])).toEqual([]);
  const before = await seed();
  const results = await Promise.allSettled([
    reorderLibraryShelves(order([...before].reverse())),
    reorderLibraryShelves(order([...before].reverse())),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
});
