import { legacyBrandNames, normalizeBrandRecord } from '@boaa/extension-contracts/brand-compat';

const JOURNAL = 'boaa.storage-migrations.v1';
const MARKER = '__boaa_brand_migration_v1__';
const pending = new WeakMap<IDBFactory, Map<string, Promise<void>>>();

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Database migration request failed'));
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Database migration transaction failed'));
  });
}

/** Aborting the creation transaction probes existence without leaving an empty legacy database. */
function existing(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    let absent = false;
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction!.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => (absent ? resolve(undefined) : reject(request.error));
    request.onblocked = () => reject(new Error('Close other application windows before migrating storage'));
  });
}
function journal(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(JOURNAL, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('completed');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage migration journal is blocked'));
  });
}
async function recordCompletion(db: IDBDatabase, name: string): Promise<void> {
  const tx = db.transaction('completed', 'readwrite');
  const done = completed(tx);
  tx.objectStore('completed').put(true, name);
  await done;
}
function createCopy(factory: IDBFactory, name: string, source: IDBDatabase): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, source.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const stores = Array.from(source.objectStoreNames);
      const tx = source.transaction(stores);
      for (const name of stores) {
        const old = tx.objectStore(name);
        const store = db.createObjectStore(name, { keyPath: old.keyPath, autoIncrement: old.autoIncrement });
        for (const name of Array.from(old.indexNames)) {
          const index = old.index(name);
          store.createIndex(name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
      db.createObjectStore(MARKER);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Storage migration is blocked'));
  });
}
async function copyStore(source: IDBDatabase, target: IDBDatabase, name: string): Promise<void> {
  let last: IDBValidKey | undefined;
  for (;;) {
    const read = source.transaction(name);
    const readDone = completed(read);
    const store = read.objectStore(name);
    const range = last === undefined ? undefined : IDBKeyRange.lowerBound(last, true);
    const [keys, values] = await Promise.all([result(store.getAllKeys(range, 100)), result(store.getAll(range, 100))]);
    await readDone;
    if (!keys.length) return;
    const write = target.transaction(name, 'readwrite');
    const writeDone = completed(write);
    const destination = write.objectStore(name);
    try {
      for (let i = 0; i < keys.length; i++) {
        const hostMetadata = ['settings', 'config', 'packages', 'repositories', 'installations', 'archives'].includes(
          name,
        );
        const value = hostMetadata ? normalizeBrandRecord(values[i]) : values[i];
        if (destination.keyPath === null) destination.put(value, keys[i]);
        else destination.put(value);
      }
    } catch (error) {
      write.abort();
      await writeDone.catch(() => undefined);
      throw error;
    }
    await writeDone;
    last = keys[keys.length - 1];
  }
}
async function migrate(factory: IDBFactory, name: string): Promise<void> {
  const aliases = legacyBrandNames(name);
  if (!aliases.length) return;
  const log = await journal(factory);
  let target: IDBDatabase | undefined;
  let source: IDBDatabase | undefined;
  try {
    if (await result(log.transaction('completed').objectStore('completed').get(name))) return;
    target = await existing(factory, name);
    if (target && !target.objectStoreNames.contains(MARKER)) {
      // Existing canonical data always wins; do not merge an older installation over it.
      await recordCompletion(log, name);
      return;
    }
    if (target && (await result(target.transaction(MARKER).objectStore(MARKER).get('complete')))) {
      await recordCompletion(log, name);
      return;
    }
    for (const alias of aliases) {
      source = await existing(factory, alias);
      if (source) break;
    }
    if (!source) {
      if (target) throw new Error('The original database for an interrupted migration is unavailable');
      await recordCompletion(log, name);
      return;
    }
    if (!source.objectStoreNames.length) {
      await recordCompletion(log, name);
      return;
    }
    target ??= await createCopy(factory, name, source);
    // Restarting an interrupted copy is safe: the application cannot open this DB until the copy completes.
    for (const store of Array.from(source.objectStoreNames)) await copyStore(source, target, store);
    const tx = target.transaction(MARKER, 'readwrite');
    const done = completed(tx);
    tx.objectStore(MARKER).put(true, 'complete');
    await done;
    await recordCompletion(log, name);
  } finally {
    target?.close();
    source?.close();
    log.close();
  }
}

/** Source data is retained. A separate journal prevents a later reset from resurrecting migrated data. */
export function prepareBrandDatabase(factory: IDBFactory, name: string): Promise<void> {
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
  let opens = pending.get(factory);
  if (!opens) {
    opens = new Map();
    pending.set(factory, opens);
  }
  const previous = opens.get(name);
  if (previous) return previous;
  const work = () => migrate(factory, name);
  const locks = globalThis.navigator?.locks;
  const opening = locks
    ? Promise.resolve(locks.request(`boaa:storage-migration:${name}`, work)).then(() => undefined)
    : work();
  opens.set(name, opening);
  void opening
    .finally(() => {
      if (opens.get(name) === opening) opens.delete(name);
    })
    .catch(() => undefined);
  return opening;
}
