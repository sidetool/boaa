import { prepareBrandDatabase } from '../storage/brand-database';
import type { LinkedLibraryFolder, StoredLibraryFolderEntry } from './contracts';

const DB_NAME = 'boaa-library-folders';
const DB_VERSION = 1;

const folderDatabases = new Map<string, Promise<IDBDatabase>>();

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openLibraryFolderDb(dbName = DB_NAME): Promise<IDBDatabase> {
  const dbPromise = folderDatabases.get(dbName);
  if (dbPromise) return dbPromise;
  const opening = (dbName === DB_NAME ? prepareBrandDatabase(indexedDB, DB_NAME) : Promise.resolve())
    .then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(dbName, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
            if (!db.objectStoreNames.contains('entries')) {
              const store = db.createObjectStore('entries', { keyPath: 'id' });
              store.createIndex('folderId', 'folderId');
              store.createIndex('bookId', 'bookId');
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => {
            if (folderDatabases.get(dbName) === opening) folderDatabases.delete(dbName);
            reject(request.error);
          };
        }),
    )
    .catch((error: unknown) => {
      folderDatabases.delete(dbName);
      throw error;
    });
  folderDatabases.set(dbName, opening);
  return opening;
}

export class LibraryFolderLocalStateStore {
  constructor(
    private readonly scope?: string,
    private readonly signal?: AbortSignal,
  ) {}
  private async openDb() {
    this.signal?.throwIfAborted();
    const db = await openLibraryFolderDb(this.scope ? `${DB_NAME}:account:${this.scope}` : DB_NAME);
    this.signal?.throwIfAborted();
    return db;
  }

  async listFolders(): Promise<LinkedLibraryFolder[]> {
    const db = await this.openDb();
    const tx = db.transaction('folders', 'readonly');
    return requestToPromise<LinkedLibraryFolder[]>(tx.objectStore('folders').getAll());
  }

  async saveFolder(folder: LinkedLibraryFolder): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(folder);
    await transactionDone(tx);
  }

  async deleteFolder(folderId: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(['folders', 'handles', 'entries'], 'readwrite');
    tx.objectStore('folders').delete(folderId);
    tx.objectStore('handles').delete(folderId);
    const entryStore = tx.objectStore('entries');
    const request = entryStore.index('folderId').openKeyCursor(IDBKeyRange.only(folderId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      entryStore.delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(tx);
  }

  async getDirectoryHandle(folderId: string): Promise<FileSystemDirectoryHandle | undefined> {
    const db = await this.openDb();
    const tx = db.transaction('handles', 'readonly');
    return requestToPromise<FileSystemDirectoryHandle | undefined>(tx.objectStore('handles').get(folderId));
  }

  async saveDirectoryHandle(folderId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, folderId);
    await transactionDone(tx);
  }

  async clearDirectoryHandle(folderId: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(folderId);
    await transactionDone(tx);
  }

  async listEntries(folderId: string): Promise<StoredLibraryFolderEntry[]> {
    const db = await this.openDb();
    const tx = db.transaction('entries', 'readonly');
    return requestToPromise<StoredLibraryFolderEntry[]>(
      tx.objectStore('entries').index('folderId').getAll(IDBKeyRange.only(folderId)),
    );
  }

  async saveEntries(entries: readonly StoredLibraryFolderEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    entries.forEach((entry) => store.put(entry));
    await transactionDone(tx);
  }

  async deleteEntry(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').delete(id);
    await transactionDone(tx);
  }
}

export async function resetLibraryFolderLocalStateForTests(): Promise<void> {
  await Promise.all([...folderDatabases.values()].map(async (promise) => (await promise).close()));
  const names = [...folderDatabases.keys()];
  folderDatabases.clear();
  for (const name of names.filter((name) => name !== DB_NAME))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Library folder state database deletion is blocked.'));
  });
}
