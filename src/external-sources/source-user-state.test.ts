import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalSourceLocalStateStore, resetExternalSourceLocalStateForTests } from './local-state';
import {
  releasePreferenceId,
  sourceDownloadQueueId,
  validReleasePreference,
  normalizeReleasePreference,
  type SourceDownloadQueue,
} from './source-user-state';

const source = { connectorId: 'fixture.source', accountConnectionId: 'account', remoteId: 'release-1' };
const item = (n: number, remoteRevision = 'v1') => ({
  key: { ...source, remoteId: `release-${n}` },
  title: `${n}`,
  sectionId: `${n}`,
  remoteRevision,
});
const queue = (items: SourceDownloadQueue['items']): SourceDownloadQueue => ({
  id: sourceDownloadQueueId(source, 'work'),
  kind: 'downloadQueue',
  connectorId: source.connectorId,
  accountConnectionId: 'account',
  collectionRemoteId: 'work',
  title: 'Work',
  updatedAt: new Date().toISOString(),
  items,
});

describe('durable source user state', () => {
  beforeEach(resetExternalSourceLocalStateForTests);
  it('persists queues across instances and preserves concurrent additions and newer revisions when checkpointing', async () => {
    const first = new ExternalSourceLocalStateStore(),
      second = new ExternalSourceLocalStateStore();
    await Promise.all([first.saveDownloadQueue(queue([item(1)])), second.saveDownloadQueue(queue([item(2)]))]);
    expect((await second.listDownloadQueues())[0]!.items).toHaveLength(2);
    await second.saveDownloadQueue(queue([item(1, 'v2')]));
    await first.pruneDownloadQueue(queue([]).id, [item(1)]);
    expect((await first.listDownloadQueues())[0]!.items.map((x) => x.remoteRevision).sort()).toEqual(['v1', 'v2']);
    await first.pruneDownloadQueue(queue([]).id, [item(1, 'v2')]);
    expect((await second.listDownloadQueues())[0]!.items.map((x) => x.key.remoteId)).toEqual(['release-2']);
    await second.pruneDownloadQueue(queue([]).id, [item(2)]);
    expect(await first.listDownloadQueues()).toEqual([]);
  });
  it('merges older array records without exposing new rows to an older tab, and checkpoints in constant writes', async () => {
    const state = new ExternalSourceLocalStateStore();
    const items = Array.from({ length: 200 }, (_, i) => item(i));
    await state.saveDownloadQueue(queue(items));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('boaa-external-sources');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const store = () => db.transaction('browsePreferences', 'readwrite').objectStore('browsePreferences');
      const get = <T>(req: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      expect((await get(store().getAll())).filter((row) => row.kind === 'downloadQueue')).toEqual([]);
      await get(store().put(queue([item(0, 'old-tab'), item(999)])));
      expect((await state.listDownloadQueues())[0]!.items).toEqual([...items, item(999)]);
      const puts = vi.spyOn(IDBObjectStore.prototype, 'put');
      const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
      try {
        await state.checkpointDownloadItems(queue([]).id, [item(0)]);
        expect(getAll).not.toHaveBeenCalled();
        expect(puts).toHaveBeenCalledTimes(1);
        expect(puts.mock.calls[0]![0]).not.toHaveProperty('items');
      } finally {
        puts.mockRestore();
        getAll.mockRestore();
      }
      // An old tab can recreate its array after migration without overwriting progress.
      await get(store().put(queue([item(1000)])));
      expect((await state.listDownloadQueues())[0]!.items).toEqual([...items.slice(1), item(999), item(1000)]);
    } finally {
      db.close();
    }
  });
  it('shares personal chapter metadata without exporting or replacing the local queue', async () => {
    const store = new ExternalSourceLocalStateStore();
    const pref = {
      id: releasePreferenceId(source),
      kind: 'releasePreference' as const,
      source,
      title: 'My title',
      collectionRemoteId: 'work',
      lastReadAt: new Date().toISOString(),
      readingMode: 'stream' as const,
      read: false,
      readChangedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(normalizeReleasePreference(pref)).toEqual(pref);
    await store.saveReleasePreferences([pref]);
    await store.saveDownloadQueue(queue([item(1)]));
    const shared = await store.exportSharedState();
    expect(shared.releasePreferences).toEqual([pref]);
    expect(JSON.stringify(shared)).not.toContain('downloadQueue');
    await store.replaceSharedState({ ...shared, releasePreferences: [{ ...pref, read: true }] });
    expect((await store.listReleasePreferences())[0]!.read).toBe(true);
    expect(await store.listDownloadQueues()).toHaveLength(1);
    await store.replaceSharedState({ ...shared, releasePreferences: [] });
    expect(await store.listReleasePreferences()).toEqual([]);
    expect(await store.listDownloadQueues()).toHaveLength(1);
  });
  it('rejects invalid timestamps and titles in the shared metadata contract', () => {
    const pref = {
      id: releasePreferenceId(source),
      kind: 'releasePreference',
      source,
      updatedAt: new Date().toISOString(),
      read: false,
    };
    expect(validReleasePreference(pref)).toBe(true);
    expect(validReleasePreference({ ...pref, readChangedAt: 'invalid' })).toBe(false);
    expect(validReleasePreference({ ...pref, title: '' })).toBe(false);
    expect(validReleasePreference({ ...pref, lastReadAt: 'invalid', collectionRemoteId: 'work' })).toBe(false);
    expect(validReleasePreference({ ...pref, lastReadAt: pref.updatedAt })).toBe(false);
    expect(validReleasePreference({ ...pref, readingMode: 'invalid' })).toBe(false);
    expect(validReleasePreference({ ...pref, source: { ...source, remoteId: 'different' } })).toBe(false);
  });
});
