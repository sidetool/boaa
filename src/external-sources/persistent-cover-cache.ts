import { prepareBrandDatabase } from '../storage/brand-database';
/** Device-local blobs. Keys include the host/account scope and source generation. */
export interface StoredCover {
  key: string;
  source: string;
  blob: Blob;
  /** Empty sentinel; older positive rows need no migration. */
  missing?: true;
  time: number;
  usedAt: number;
}
export interface CoverStorage {
  get(key: string): Promise<StoredCover | undefined>;
  put(key: string, blob: Blob, time: number): Promise<void>;
  putMissing?(key: string, time: number): Promise<void>;
  invalidateSource(source: string): Promise<void>;
}
export const COVER_DISK_MAX_BYTES = 256 * 1024 * 1024;
export const COVER_DISK_MAX_ENTRIES = 2000;
export const COVER_RETAIN_MS = 365 * 86400_000;

export class PersistentCoverCache implements CoverStorage {
  constructor(
    private scope: string,
    private maxBytes = COVER_DISK_MAX_BYTES,
    private maxEntries = COVER_DISK_MAX_ENTRIES,
    private databaseName = 'boaa-cover-blobs-v1',
  ) {}
  private async transaction<T>(run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    if (typeof indexedDB === 'undefined') throw new Error('cover_storage_unavailable');
    const db = await prepareBrandDatabase(indexedDB, this.databaseName).then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(this.databaseName, 1);
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('covers', { keyPath: 'key' });
            store.createIndex('usedAt', 'usedAt');
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('covers', 'readwrite');
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error ?? new Error('cover_storage_aborted'));
        tx.onerror = () => reject(tx.error);
        run(tx.objectStore('covers'), (next) => {
          value = next;
        });
      });
    } finally {
      db.close();
    }
  }
  private key(key: string) {
    return JSON.stringify([this.scope, key]);
  }
  async get(key: string) {
    return this.transaction<StoredCover | undefined>((store, result) => {
      const request = store.get(this.key(key));
      request.onsuccess = () => {
        const row = request.result as StoredCover | undefined;
        if (!row) return result(undefined);
        if (row.time + COVER_RETAIN_MS <= Date.now()) {
          store.delete(row.key);
          return result(undefined);
        }
        row.usedAt = Date.now();
        store.put(row);
        result(row);
      };
    });
  }
  putMissing(key: string, time: number) {
    return this.write(key, new Blob([]), time, true);
  }
  put(key: string, blob: Blob, time: number) {
    return this.write(key, blob, time);
  }
  private async write(key: string, blob: Blob, time: number, missing?: true) {
    if (blob.size > this.maxBytes) return;
    await this.transaction<void>((store) => {
      store.put({
        key: this.key(key),
        source: JSON.stringify([this.scope, JSON.parse(key)[0]]),
        blob,
        missing,
        time,
        usedAt: Date.now(),
      });
      // Newest first: the entire database shares one budget, including inactive accounts.
      let bytes = 0,
        count = 0;
      const request = store.index('usedAt').openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as StoredCover;
        if (
          row.time + COVER_RETAIN_MS <= Date.now() ||
          count >= this.maxEntries ||
          bytes + row.blob.size > this.maxBytes
        )
          cursor.delete();
        else {
          bytes += row.blob.size;
          count++;
        }
        cursor.continue();
      };
    });
  }
  async invalidateSource(source: string) {
    await this.transaction<void>((store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if ((cursor.value as StoredCover).source === JSON.stringify([this.scope, source])) cursor.delete();
        cursor.continue();
      };
    });
  }
}
