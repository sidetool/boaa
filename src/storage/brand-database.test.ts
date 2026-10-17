import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareBrandDatabase } from './brand-database';

vi.stubGlobal('IDBKeyRange', IDBKeyRange);
function open(factory: IDBFactory, name: string, initialize?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onupgradeneeded = () => initialize?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
async function rows(factory: IDBFactory, name: string, store = 'settings') {
  const db = await open(factory, name);
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
async function seed(factory: IDBFactory, name: string, values: unknown[]) {
  const db = await open(factory, name, (db) => {
    const store = db.createObjectStore('settings', { keyPath: 'id' });
    store.createIndex('label', 'label');
    db.createObjectStore('handles');
  });
  const tx = db.transaction('settings', 'readwrite');
  const completed = done(tx);
  for (const value of values) tx.objectStore('settings').put(value);
  await completed;
  db.close();
}

afterEach(() => vi.restoreAllMocks());
describe('BOAA IndexedDB migration', () => {
  it.each(['noveldesk-reader', 'moya-reader'])(
    'copies %s with schema, indexes, blobs and reserved settings',
    async (legacy) => {
      const factory = new IDBFactory();
      const blob = new Blob(['private user data']);
      await seed(factory, legacy, [{ id: 'book', label: 'saved', blob, _moyaIntegrations: { 'moya.ai': false } }]);
      await prepareBrandDatabase(factory, 'boaa-reader');
      const [record] = (await rows(factory, 'boaa-reader')) as { blob: Blob; _boaaIntegrations: unknown }[];
      expect(await record.blob.text()).toBe('private user data');
      expect(record._boaaIntegrations).toEqual({ 'boaa.ai': false });
      const db = await open(factory, 'boaa-reader');
      expect([...db.transaction('settings').objectStore('settings').indexNames]).toEqual(['label']);
      expect(db.objectStoreNames.contains('handles')).toBe(true);
      db.close();
      expect(await rows(factory, legacy)).toHaveLength(1);
    },
  );
  it('keeps existing BOAA data authoritative', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'noveldesk-reader', [{ id: 'old' }]);
    await seed(factory, 'boaa-reader', [{ id: 'new' }]);
    await prepareBrandDatabase(factory, 'boaa-reader');
    expect(await rows(factory, 'boaa-reader')).toEqual([{ id: 'new' }]);
  });
  it('retries an interrupted chunked copy without losing or duplicating records', async () => {
    const factory = new IDBFactory();
    await seed(
      factory,
      'noveldesk-reader',
      Array.from({ length: 251 }, (_, id) => ({ id })),
    );
    const partial = await open(factory, 'boaa-reader', (db) => {
      db.createObjectStore('settings', { keyPath: 'id' }).createIndex('label', 'label');
      db.createObjectStore('handles');
      db.createObjectStore('__boaa_brand_migration_v1__');
    });
    const tx = partial.transaction('settings', 'readwrite');
    const completed = done(tx);
    tx.objectStore('settings').put({ id: 0 });
    await completed;
    partial.close();
    await prepareBrandDatabase(factory, 'boaa-reader');
    expect(await rows(factory, 'boaa-reader')).toHaveLength(251);
    await prepareBrandDatabase(factory, 'boaa-reader');
    expect(await rows(factory, 'boaa-reader')).toHaveLength(251);
  });
  it('does not resurrect the old database after a user resets migrated BOAA data', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'noveldesk-reader', [{ id: 'old' }]);
    await prepareBrandDatabase(factory, 'boaa-reader');
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('boaa-reader');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await prepareBrandDatabase(factory, 'boaa-reader');
    expect((await factory.databases()).some((entry) => entry.name === 'boaa-reader')).toBe(false);
  });
  it('does not leave empty legacy databases during a fresh installation', async () => {
    const factory = new IDBFactory();
    await prepareBrandDatabase(factory, 'boaa-reader');
    expect((await factory.databases()).map((entry) => entry.name)).toEqual(['boaa.storage-migrations.v1']);
  });
  it('copies a profile-scoped extension database', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'moya.js-plugins.v1:profile', [{ id: 'example.plugin', enabled: false }]);
    await Promise.all([
      prepareBrandDatabase(factory, 'boaa.js-plugins.v1:profile'),
      prepareBrandDatabase(factory, 'boaa.js-plugins.v1:profile'),
    ]);
    expect(await rows(factory, 'boaa.js-plugins.v1:profile')).toEqual([{ id: 'example.plugin', enabled: false }]);
  });
});
