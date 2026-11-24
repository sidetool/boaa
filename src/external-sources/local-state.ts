import { prepareBrandDatabase } from '../storage/brand-database';
import type {
  ExternalCatalogCachePage,
  ExternalSourceBrowseMode,
  ExternalSourceCredentialRecord,
  ExternalSourceFilterChange,
  ExternalSourceFilterValue,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from './contracts';
import { createExternalSourceCredentialKey } from './device-credential-crypto';
import { externalItemKeyId, type ExternalItemKey } from './contracts';
import { releasePreferenceId } from './source-user-state';
import type { SourceDownloadQueue, SourceReleasePreference } from './source-user-state';
import type {
  ExternalSourceSharedConnectionV1,
  ExternalSourceSharedStateV1,
} from '../integration-settings/self-host-integration-settings';

const DB_NAME = 'boaa-external-sources';
const cacheClearListeners = new Set<(scope?: string) => void>();

/** A metadata clear also retires active discovery reads before they can save back into that store. */
export function subscribeSourceCacheClear(listener: (scope?: string) => void) {
  cacheClearListeners.add(listener);
  return () => {
    cacheClearListeners.delete(listener);
  };
}

function notifySourceCacheClear(scope?: string) {
  for (const listener of cacheClearListeners) listener(scope);
}

function cachedConnection(page: ExternalCatalogCachePage) {
  if (page.accountConnectionId !== undefined) return page.accountConnectionId;
  // Previously discovery stored the connection only inside its persisted list/schema key.
  try {
    const key: unknown = JSON.parse(page.id.replace(/^schema:/u, ''));
    if (Array.isArray(key) && key.length === 6 && key[1] === page.connectorId) return key[3];
  } catch {
    /* Other catalog stores use opaque IDs. */
  }
  return undefined;
}
// Keep this at the last shipped version. Shared connection hints are server-owned in self-host mode
// and reconstructed from the encrypted device credential in local mode, so they need no new store.
const DB_VERSION = 6;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_PAGES = 1000;
const CREDENTIAL_KEY_ID = 'external-source-credentials-v1';

const sourceDatabases = new Map<string, Promise<IDBDatabase>>();
const credentialKeys = new Map<string, Promise<CryptoKey>>();

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

type QueueItem = SourceDownloadQueue['items'][number];
type QueueHeader = Omit<SourceDownloadQueue, 'items'> & { count: number; nextPosition: number };
type QueueRow = { id: [string, string]; position: number; item: QueueItem };

function queueRows(id: string) {
  return IDBKeyRange.bound([id], [id, []]);
}

const headerPrefix = 'source-queue-header:';
const releasePreferencesRange = () => IDBKeyRange.bound('release-preference:', 'release-preference:\uffff');
function writeQueueHeader(store: IDBObjectStore, header: QueueHeader) {
  store.put({ ...header, kind: 'downloadQueueHeader', id: headerPrefix + header.id });
}

async function readQueueHeader(store: IDBObjectStore, id: string): Promise<QueueHeader | undefined> {
  const [saved, legacy] = await Promise.all([
    requestToPromise<QueueHeader | undefined>(store.get(headerPrefix + id)),
    requestToPromise<SourceDownloadQueue | undefined>(store.get(id)),
  ]);
  const header = saved && { ...saved, kind: 'downloadQueue' as const, id };
  if (!legacy) return header;
  // An older tab can still write the original array record. Merge on every encounter
  // without replacing this client's outstanding entries or newer revisions.
  const { items, ...metadata } = legacy;
  const next = header ?? { ...metadata, count: 0, nextPosition: 0 };
  const unique = [...new Map(items.map((item) => [externalItemKeyId(item.key), item])).entries()];
  const existing = await Promise.all(
    unique.map(([key]) => requestToPromise<QueueRow | undefined>(store.get([id, key]))),
  );
  unique.forEach(([key, item], index) => {
    if (!existing[index]) {
      store.put({ id: [id, key], item, position: next.nextPosition++ });
      next.count++;
    }
  });
  writeQueueHeader(store, next);
  store.delete(id);
  return next;
}

async function readQueue(store: IDBObjectStore, header: QueueHeader): Promise<SourceDownloadQueue> {
  const { id, kind, connectorId, accountConnectionId, collectionRemoteId, title, updatedAt } = header;
  const rows = await requestToPromise<QueueRow[]>(store.getAll(queueRows(header.id)));
  return {
    id,
    kind,
    connectorId,
    accountConnectionId,
    collectionRemoteId,
    title,
    updatedAt,
    items: rows.sort((a, b) => a.position - b.position).map((row) => row.item),
  };
}

function openExternalSourceDb(dbName = DB_NAME): Promise<IDBDatabase> {
  const dbPromise = sourceDatabases.get(dbName);
  if (dbPromise) return dbPromise;
  const opening = (dbName === DB_NAME ? prepareBrandDatabase(indexedDB, DB_NAME) : Promise.resolve())
    .then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(dbName, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('credentials')) {
              const store = db.createObjectStore('credentials', { keyPath: 'id' });
              store.createIndex('connectorId', 'connectorId');
            }
            if (!db.objectStoreNames.contains('cachePages')) {
              const store = db.createObjectStore('cachePages', { keyPath: 'id' });
              store.createIndex('connectorId', 'connectorId');
              store.createIndex('accountConnectionId', 'accountConnectionId');
            }
            if (!db.objectStoreNames.contains('links')) {
              const store = db.createObjectStore('links', { keyPath: 'id' });
              store.createIndex('connectorId', 'source.connectorId');
              store.createIndex('localBookId', 'localBookId');
            }
            if (!db.objectStoreNames.contains('credentialKeys')) {
              db.createObjectStore('credentialKeys', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('associationPurgeIntents')) {
              db.createObjectStore('associationPurgeIntents', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('browsePreferences')) {
              const store = db.createObjectStore('browsePreferences', { keyPath: 'id' });
              store.createIndex('connectorId', 'connectorId');
            }
            if (!db.objectStoreNames.contains('selectedItems')) {
              const store = db.createObjectStore('selectedItems', { keyPath: 'id' });
              store.createIndex('connectorId', 'connectorId');
              store.createIndex('accountConnectionId', 'accountConnectionId');
            }
            if (!db.objectStoreNames.contains('subscriptions')) {
              const store = db.createObjectStore('subscriptions', { keyPath: 'id' });
              store.createIndex('connectorId', 'connectorId');
              store.createIndex('accountConnectionId', 'accountConnectionId');
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => {
            if (request.error?.name === 'VersionError') {
              // A pre-release build briefly created v7. Open that database at its current
              // version without advancing it again; clean installs remain on shipped v6.
              const fallback = indexedDB.open(dbName);
              fallback.onsuccess = () => resolve(fallback.result);
              fallback.onerror = () => {
                if (sourceDatabases.get(dbName) === opening) sourceDatabases.delete(dbName);
                reject(fallback.error);
              };
              return;
            }
            if (sourceDatabases.get(dbName) === opening) sourceDatabases.delete(dbName);
            reject(request.error);
          };
        }),
    )
    .catch((error: unknown) => {
      sourceDatabases.delete(dbName);
      throw error;
    });
  sourceDatabases.set(dbName, opening);
  return opening;
}

export interface ExternalSourceFolderBreadcrumb {
  readonly label: string;
  readonly parentRef: string;
}

export interface ExternalSourceDefaultFolder {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly breadcrumbs: readonly ExternalSourceFolderBreadcrumb[];
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceDefaultFolderId(connectorId: string, accountConnectionId: string | undefined): string {
  return ['external-source-default-folder', connectorId, accountConnectionId ?? ''].join('::');
}

export interface ExternalSourceCatalogPreference {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly browseMode: Exclude<ExternalSourceBrowseMode, 'search'>;
  readonly filterValues: Readonly<Record<string, ExternalSourceFilterValue>>;
  readonly filters: readonly ExternalSourceFilterChange[];
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceCatalogPreferenceId(
  connectorId: string,
  accountConnectionId: string | undefined,
  parentRef: string,
): string {
  return ['external-source-catalog-preference', connectorId, accountConnectionId ?? '', parentRef].join('::');
}

export interface ExternalSourceSubscriptionRecord {
  readonly titleUnknown?: boolean;
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly collectionRemoteId: string;
  readonly navigationRef: string;
  readonly sourceNavigationRef?: string;
  readonly deletedAt?: string;
  readonly title: string;
  readonly titleOverride?: string;
  readonly shelfIds?: readonly string[];
  readonly author?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  readonly sourceLabel?: string;
  readonly knownReleaseIds: readonly string[];
  readonly newReleaseIds: readonly string[];
  /** Missing/false means older unseen pages must first establish a complete metadata baseline. */
  readonly releaseBaselineComplete?: boolean;
  readonly availableReleaseCount: number;
  readonly lastCheckedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

export function externalSourceSubscriptionId(
  connectorId: string,
  accountConnectionId: string | undefined,
  collectionRemoteId: string,
): string {
  return ['external-source-subscription', connectorId, accountConnectionId ?? '', collectionRemoteId].join('::');
}

export interface SourceAssociationPurgeIntent {
  readonly id: string;
  readonly work: ExternalItemKey;
  readonly scope?: string;
  readonly releaseIds: readonly string[];
  readonly resetAt: string;
}

export interface MissingBookHistoryContext {
  readonly scope?: string;
  readonly preferences?: readonly SourceReleasePreference[];
}

export interface ExternalSourceLocalState {
  listReleasePreferences?(): Promise<SourceReleasePreference[]>;
  saveReleasePreferences?(records: readonly SourceReleasePreference[]): Promise<void>;
  /** Atomically compare a journal visit with the current reset/visit timestamp and return the authoritative record. */
  replaySourceStreamVisit?(visit: SourceReleasePreference): Promise<SourceReleasePreference>;
  listDownloadQueues?(exclude?: ReadonlySet<string>): Promise<SourceDownloadQueue[]>;
  saveDownloadQueue?(queue: SourceDownloadQueue): Promise<void>;
  deleteDownloadQueue?(id: string): Promise<void>;
  checkpointDownloadItems?(id: string, completed: SourceDownloadQueue['items']): Promise<void>;
  pruneDownloadQueue?(id: string, completed: SourceDownloadQueue['items']): Promise<SourceDownloadQueue | undefined>;
  getOrCreateCredentialKey(): Promise<CryptoKey>;
  getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined>;
  saveCredential(record: ExternalSourceCredentialRecord): Promise<void>;
  deleteCredential(connectorId: string): Promise<void>;
  getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined>;
  deleteCachePage?(id: string): Promise<void>;
  saveCachePage(page: ExternalCatalogCachePage): Promise<void>;
  clearCache(connectorId: string, accountConnectionId?: string): Promise<void>;
  listLinks(connectorId?: string): Promise<ExternalSourceLink[]>;
  saveLink(link: ExternalSourceLink): Promise<void>;
  saveLinks?(links: readonly ExternalSourceLink[]): Promise<void>;
  deleteLinks?(ids: readonly string[]): Promise<void>;
  /** Delete only unchanged links whose books were absent from a successful, trash-inclusive catalog read. */
  removeMissingBookLinks?(expected: readonly ExternalSourceLink[], history?: MissingBookHistoryContext): Promise<void>;
  listAssociationPurgeIntents?(): Promise<SourceAssociationPurgeIntent[]>;
  acknowledgeAssociationPurgeIntent?(intent: SourceAssociationPurgeIntent): Promise<void>;
  replaceLinks?(links: readonly ExternalSourceLink[], deleteIds: readonly string[]): Promise<void>;
  acquirePendingLinks?(links: readonly ExternalSourceLink[]): Promise<boolean>;
  compareAndSwapPendingLinks?(
    expected: readonly { readonly id: string; readonly operationId: string }[],
    links: readonly ExternalSourceLink[],
    deleteIds: readonly string[],
  ): Promise<boolean>;
  getDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<ExternalSourceDefaultFolder | undefined>;
  saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void>;
  deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void>;
  getCatalogPreference(
    connectorId: string,
    accountConnectionId: string | undefined,
    parentRef: string,
  ): Promise<ExternalSourceCatalogPreference | undefined>;
  saveCatalogPreference(preference: ExternalSourceCatalogPreference): Promise<void>;
  listSubscriptions(connectorId?: string, accountConnectionId?: string): Promise<ExternalSourceSubscriptionRecord[]>;
  saveSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]>;
  saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void>;
  deleteSelectedItem(id: string): Promise<void>;
  getSharedConnection?(connectorId: string): Promise<ExternalSourceSharedConnectionV1 | undefined>;
  saveSharedConnection?(connection: ExternalSourceSharedConnectionV1): Promise<void>;
  deleteSharedConnection?(connectorId: string): Promise<void>;
}

export class ExternalSourceLocalStateStore implements ExternalSourceLocalState {
  private readonly dbName: string;
  constructor(
    readonly scope?: string,
    private readonly signal?: AbortSignal,
  ) {
    this.dbName = scope ? `${DB_NAME}:account:${scope}` : DB_NAME;
  }
  private async openDb() {
    this.signal?.throwIfAborted();
    const db = await openExternalSourceDb(this.dbName);
    this.signal?.throwIfAborted();
    return db;
  }
  dispose() {
    credentialKeys.delete(this.dbName);
    this.sharedConnections.clear();
  }

  async listReleasePreferences(): Promise<SourceReleasePreference[]> {
    const db = await this.openDb();
    if (!db.objectStoreNames.contains('browsePreferences')) return [];
    const rows = await requestToPromise<SourceReleasePreference[]>(
      db.transaction('browsePreferences').objectStore('browsePreferences').getAll(releasePreferencesRange()),
    );
    return rows.filter((row) => row.kind === 'releasePreference');
  }

  async saveReleasePreferences(records: readonly SourceReleasePreference[]): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    records.forEach((record) => tx.objectStore('browsePreferences').put(record));
    await transactionDone(tx);
    this.publishSharedChange();
  }

  async replaySourceStreamVisit(visit: SourceReleasePreference): Promise<SourceReleasePreference> {
    if (
      visit.id !== releasePreferenceId(visit.source) ||
      !visit.lastReadAt ||
      !Number.isFinite(Date.parse(visit.lastReadAt)) ||
      visit.read !== true ||
      visit.readingMode !== 'stream'
    ) {
      throw new Error('Invalid source stream visit');
    }
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('browsePreferences');
    const current = await requestToPromise<SourceReleasePreference | undefined>(store.get(visit.id));
    const superseded =
      current && ((current.readChangedAt ?? '') >= visit.lastReadAt || (current.lastReadAt ?? '') >= visit.lastReadAt);
    const next = superseded ? current : { ...current, ...visit };
    if (!superseded) store.put(next);
    await done;
    if (!superseded) this.publishSharedChange();
    return next;
  }

  async listDownloadQueues(exclude?: ReadonlySet<string>): Promise<SourceDownloadQueue[]> {
    const db = await this.openDb();
    if (!db.objectStoreNames.contains('browsePreferences')) return [];
    const tx = db.transaction('browsePreferences', 'readwrite');
    const store = tx.objectStore('browsePreferences');
    const prefixes = ['download-queue:', headerPrefix];
    const [legacy, headers] = await Promise.all(
      prefixes.map((prefix) => requestToPromise(store.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')))),
    );
    const ids = new Set([...legacy.map(String), ...headers.map((key) => String(key).slice(headerPrefix.length))]);
    const queues = await Promise.all(
      [...ids]
        .filter((id) => !exclude?.has(id))
        .map(async (id) => readQueue(store, (await readQueueHeader(store, id))!)),
    );
    await transactionDone(tx);
    return queues;
  }

  async saveDownloadQueue(queue: SourceDownloadQueue): Promise<void> {
    const { items, ...metadata } = queue;
    if (items.length > 50_000) throw new Error('한 작품의 대기열은 50,000회차까지 저장할 수 있습니다.');
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    const store = tx.objectStore('browsePreferences');
    const previous = await readQueueHeader(store, queue.id);
    const unique = [...new Map(items.map((item) => [externalItemKeyId(item.key), item])).entries()];
    const existing = await Promise.all(
      unique.map(([key]) => requestToPromise<QueueRow | undefined>(store.get([queue.id, key]))),
    );
    const count = (previous?.count ?? 0) + existing.filter((row) => !row).length;
    if (count > 50_000) {
      tx.abort();
      throw new Error('대기열 회차 한도를 초과했습니다.');
    }
    let nextPosition = previous?.nextPosition ?? 0;
    unique.forEach(([key, item], index) => {
      store.put({ id: [queue.id, key], item, position: existing[index]?.position ?? nextPosition++ });
    });
    if (count) writeQueueHeader(store, { ...metadata, count, nextPosition });
    await transactionDone(tx);
  }

  async checkpointDownloadItems(id: string, completed: SourceDownloadQueue['items']): Promise<void> {
    if (!completed.length) return;
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    const store = tx.objectStore('browsePreferences');
    const header = await readQueueHeader(store, id);
    if (!header) return;
    const unique = new Map(completed.map((item) => [externalItemKeyId(item.key), item]));
    const rows = await Promise.all(
      [...unique.keys()].map((key) => requestToPromise<QueueRow | undefined>(store.get([id, key]))),
    );
    let count = header.count;
    for (const row of rows) {
      if (row && unique.get(row.id[1])!.remoteRevision === row.item.remoteRevision) {
        store.delete(row.id);
        count--;
      }
    }
    if (count === 0) store.delete(headerPrefix + id);
    else if (count !== header.count) writeQueueHeader(store, { ...header, count });
    await transactionDone(tx);
  }

  async pruneDownloadQueue(
    id: string,
    completed: SourceDownloadQueue['items'],
  ): Promise<SourceDownloadQueue | undefined> {
    await this.checkpointDownloadItems(id, completed);
    const db = await this.openDb();
    const store = db.transaction('browsePreferences', 'readwrite').objectStore('browsePreferences');
    const header = await readQueueHeader(store, id);
    return header && readQueue(store, header);
  }

  async deleteDownloadQueue(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    const store = tx.objectStore('browsePreferences');
    store.delete(id);
    store.delete(headerPrefix + id);
    store.delete(queueRows(id));
    await transactionDone(tx);
  }
  private readonly sharedChangeListeners = new Set<() => void>();
  private readonly sharedConnections = new Map<string, ExternalSourceSharedConnectionV1>();

  subscribeSharedChanges(listener: () => void): () => void {
    this.sharedChangeListeners.add(listener);
    return () => this.sharedChangeListeners.delete(listener);
  }

  private publishSharedChange(): void {
    for (const listener of this.sharedChangeListeners) listener();
  }

  async getOrCreateCredentialKey(): Promise<CryptoKey> {
    this.signal?.throwIfAborted();
    const cached = credentialKeys.get(this.dbName);
    if (cached) return cached;
    const credentialKeyPromise = this.loadOrCreateCredentialKey().catch((error) => {
      credentialKeys.delete(this.dbName);
      throw error;
    });
    credentialKeys.set(this.dbName, credentialKeyPromise);
    return credentialKeyPromise;
  }

  private async loadOrCreateCredentialKey(): Promise<CryptoKey> {
    const db = await this.openDb();
    const readTx = db.transaction('credentialKeys', 'readonly');
    const existing = await requestToPromise<{ id: string; key: CryptoKey } | undefined>(
      readTx.objectStore('credentialKeys').get(CREDENTIAL_KEY_ID),
    );
    if (existing?.key) return existing.key;

    const key = await createExternalSourceCredentialKey();
    const writeTx = db.transaction('credentialKeys', 'readwrite');
    writeTx.objectStore('credentialKeys').put({ id: CREDENTIAL_KEY_ID, key, createdAt: new Date().toISOString() });
    await transactionDone(writeTx);
    return key;
  }

  async getCredential(connectorId: string): Promise<ExternalSourceCredentialRecord | undefined> {
    const db = await this.openDb();
    const tx = db.transaction('credentials', 'readonly');
    const records = await requestToPromise<ExternalSourceCredentialRecord[]>(
      tx.objectStore('credentials').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records[0];
  }

  async saveCredential(record: ExternalSourceCredentialRecord): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').put(record);
    await transactionDone(tx);
  }

  async deleteCredential(connectorId: string): Promise<void> {
    const record = await this.getCredential(connectorId);
    if (!record) return;
    const db = await this.openDb();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').delete(record.id);
    await transactionDone(tx);
  }

  async getCachePage(id: string): Promise<ExternalCatalogCachePage | undefined> {
    const db = await this.openDb();
    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    const page = await requestToPromise<ExternalCatalogCachePage | undefined>(store.get(id));
    const keepUntil = page?.retainUntil
      ? Date.parse(page.retainUntil)
      : Date.parse(page?.fetchedAt ?? '') + 7 * 86400_000;
    if (!page || !Number.isFinite(keepUntil) || keepUntil <= Date.now()) {
      if (page) store.delete(id);
      await transactionDone(tx);
      return undefined;
    }
    store.put({ ...page, lastAccessedAt: new Date().toISOString() });
    await transactionDone(tx);
    return page;
  }

  async saveCachePage(page: ExternalCatalogCachePage): Promise<void> {
    const fetchedAt = Date.parse(page.fetchedAt);
    const retainUntil = Math.min(
      Date.parse(page.retainUntil ?? '') || fetchedAt + 7 * 86400_000,
      fetchedAt + 7 * 86400_000,
    );
    const byteLength = new TextEncoder().encode(JSON.stringify(page)).length;
    const db = await this.openDb();
    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    const existing = await requestToPromise<ExternalCatalogCachePage[]>(store.getAll());
    store.delete(page.id);
    const rows = existing
      .filter((entry) => entry.id !== page.id)
      .sort((a, b) => (b.lastAccessedAt ?? b.fetchedAt).localeCompare(a.lastAccessedAt ?? a.fetchedAt));
    const save = Number.isFinite(retainUntil) && retainUntil > Date.now() && byteLength <= MAX_CACHE_BYTES;
    let bytes = save ? byteLength : 0,
      count = save ? 1 : 0;
    for (const entry of rows) {
      const expiry = Date.parse(entry.retainUntil ?? '') || Date.parse(entry.fetchedAt) + 7 * 86400_000;
      const size = entry.byteLength ?? new TextEncoder().encode(JSON.stringify(entry)).length;
      if (
        !Number.isFinite(expiry) ||
        expiry <= Date.now() ||
        count >= MAX_CACHE_PAGES ||
        bytes + size > MAX_CACHE_BYTES
      )
        store.delete(entry.id);
      else {
        bytes += size;
        count++;
      }
    }
    if (save)
      store.put({
        ...page,
        byteLength,
        retainUntil: new Date(retainUntil).toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
    await transactionDone(tx);
  }

  async clearCache(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('cachePages', 'readwrite');
    const store = tx.objectStore('cachePages');
    const request = store.index('connectorId').openCursor(IDBKeyRange.only(connectorId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const page = cursor.value as ExternalCatalogCachePage;
      if (accountConnectionId === undefined || cachedConnection(page) === accountConnectionId) cursor.delete();
      cursor.continue();
    };
    notifySourceCacheClear(this.scope);
    await transactionDone(tx);
  }

  async deleteCachePage(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('cachePages', 'readwrite');
    tx.objectStore('cachePages').delete(id);
    await transactionDone(tx);
  }

  async listLinks(connectorId?: string): Promise<ExternalSourceLink[]> {
    const db = await this.openDb();
    const tx = db.transaction('links', 'readonly');
    const store = tx.objectStore('links');
    return connectorId
      ? requestToPromise<ExternalSourceLink[]>(store.index('connectorId').getAll(IDBKeyRange.only(connectorId)))
      : requestToPromise<ExternalSourceLink[]>(store.getAll());
  }

  async saveLink(link: ExternalSourceLink): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').put(link);
    await transactionDone(tx);
    if (!link.pendingImport) this.publishSharedChange();
  }

  async saveLinks(links: readonly ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    links.forEach((link) => store.put(link));
    await transactionDone(tx);
    if (links.some((link) => !link.pendingImport)) this.publishSharedChange();
  }

  async deleteLinks(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    ids.forEach((id) => store.delete(id));
    await transactionDone(tx);
    this.publishSharedChange();
  }

  async replaceLinks(links: readonly ExternalSourceLink[], deleteIds: readonly string[]): Promise<void> {
    if (links.length === 0 && deleteIds.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    const store = tx.objectStore('links');
    links.forEach((link) => store.put(link));
    deleteIds.forEach((id) => store.delete(id));
    await transactionDone(tx);
    if (deleteIds.length > 0 || links.some((link) => !link.pendingImport)) this.publishSharedChange();
  }

  async listAssociationPurgeIntents(): Promise<SourceAssociationPurgeIntent[]> {
    const db = await this.openDb();
    return requestToPromise(db.transaction('associationPurgeIntents').objectStore('associationPurgeIntents').getAll());
  }

  async acknowledgeAssociationPurgeIntent(intent: SourceAssociationPurgeIntent): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('associationPurgeIntents', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('associationPurgeIntents');
    const current = await requestToPromise<SourceAssociationPurgeIntent | undefined>(store.get(intent.id));
    if (JSON.stringify(current) === JSON.stringify(intent)) store.delete(intent.id);
    await done;
  }

  async removeMissingBookLinks(
    expected: readonly ExternalSourceLink[],
    history: MissingBookHistoryContext = {},
  ): Promise<void> {
    if (expected.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction(['links', 'subscriptions', 'browsePreferences', 'associationPurgeIntents'], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('links');
    const current = await Promise.all(
      expected.map((link) => requestToPromise<ExternalSourceLink | undefined>(store.get(link.id))),
    );
    const removed = expected.filter(
      (link, index) => !link.pendingImport && JSON.stringify(current[index]) === JSON.stringify(link),
    );
    removed.forEach((link) => store.delete(link.id));
    // Subscription-only works have no link and must stay in the Library. Remove a
    // subscription only when its last downloaded-book association was just removed.
    const collectionKey = (link: ExternalSourceLink) =>
      link.collectionRemoteId
        ? externalSourceSubscriptionId(
            link.source.connectorId,
            link.source.accountConnectionId,
            link.collectionRemoteId,
          )
        : undefined;
    const affected = new Set(removed.map(collectionKey).filter((id): id is string => Boolean(id)));
    if (affected.size > 0) {
      const remaining = await requestToPromise<ExternalSourceLink[]>(store.getAll());
      remaining.forEach((link) => affected.delete(collectionKey(link) ?? ''));
      const preferencesStore = tx.objectStore('browsePreferences');
      const preferences = (
        await requestToPromise<SourceReleasePreference[]>(preferencesStore.getAll(releasePreferencesRange()))
      ).filter((p) => p.kind === 'releasePreference');
      for (const id of affected) {
        const association = removed.find((link) => collectionKey(link) === id)!;
        const work = { ...association.source, remoteId: association.collectionRemoteId! };
        const belongs = (p: SourceReleasePreference) =>
          p.source.connectorId === work.connectorId &&
          (p.source.accountConnectionId ?? '') === (work.accountConnectionId ?? '') &&
          p.collectionRemoteId === work.remoteId;
        const subscription = await requestToPromise<ExternalSourceSubscriptionRecord | undefined>(
          tx.objectStore('subscriptions').get(id),
        );
        const receiptId = JSON.stringify([history.scope ?? 'local', id]);
        const previousIntent = await requestToPromise<SourceAssociationPurgeIntent | undefined>(
          tx.objectStore('associationPurgeIntents').get(receiptId),
        );
        const previousById = new Map(preferences.map((p) => [p.id, p]));
        const targets = new Map<string, SourceReleasePreference>();
        for (const p of [...(history.preferences ?? []), ...preferences].filter(belongs)) targets.set(p.id, p);
        for (const link of removed.filter((link) => collectionKey(link) === id)) {
          const key = releasePreferenceId(link.source);
          if (!targets.has(key))
            targets.set(key, {
              ...previousById.get(key),
              id: key,
              kind: 'releasePreference',
              source: link.source,
              collectionRemoteId: work.remoteId,
              updatedAt: link.linkedAt,
            });
        }
        for (const remoteId of [...(subscription?.knownReleaseIds ?? []), ...(previousIntent?.releaseIds ?? [])]) {
          const source = { ...work, remoteId };
          const key = releasePreferenceId(source);
          if (!targets.has(key))
            targets.set(key, {
              ...previousById.get(key),
              id: key,
              kind: 'releasePreference',
              source,
              collectionRemoteId: work.remoteId,
              updatedAt: association.linkedAt,
            });
        }
        const resetAt = new Date(
          [...(history.preferences ?? []), ...targets.values()]
            .filter(belongs)
            .reduce(
              (latest, p) =>
                Math.max(
                  latest,
                  (Date.parse(p.readChangedAt ?? '') || 0) + 1,
                  (Date.parse(p.lastReadAt ?? '') || 0) + 1,
                ),
              Date.now(),
            ),
        ).toISOString();
        // Suppression and membership removal commit together. A failed device-history
        // cleanup can retry without restoring the work or touching a later visit.
        for (const p of targets.values())
          preferencesStore.put({
            ...p,
            read: false,
            readChangedAt: resetAt,
            lastReadAt: undefined,
            readingMode: undefined,
            updatedAt: resetAt,
          });
        tx.objectStore('associationPurgeIntents').put({
          id: receiptId,
          work,
          scope: history.scope,
          releaseIds: [...targets.values()].map((p) => p.source.remoteId),
          resetAt,
        } satisfies SourceAssociationPurgeIntent);
        tx.objectStore('subscriptions').delete(id);
      }
    }
    await done;
    if (removed.length > 0) this.publishSharedChange();
  }

  async acquirePendingLinks(links: readonly ExternalSourceLink[]): Promise<boolean> {
    if (links.length === 0 || links.some((link) => !link.pendingImport)) return false;
    if (new Set(links.map((link) => link.id)).size !== links.length) return false;
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('links');
    const current = await Promise.all(
      links.map((link) => requestToPromise<ExternalSourceLink | undefined>(store.get(link.id))),
    );
    const canAcquire = links.every((staged, index) => {
      const pending = staged.pendingImport!;
      const existing = current[index];
      if (existing?.pendingImport) return existing.pendingImport.operationId === pending.operationId;
      if (!pending.hadExistingLink) return existing === undefined;
      return (
        existing !== undefined &&
        existing.localBookId === staged.localBookId &&
        existing.source.connectorId === staged.source.connectorId &&
        existing.source.accountConnectionId === staged.source.accountConnectionId &&
        existing.source.remoteId === staged.source.remoteId &&
        existing.importedRemoteRevision === staged.importedRemoteRevision &&
        existing.importedSourceContentHash === staged.importedSourceContentHash &&
        existing.activeContentRevisionId === staged.activeContentRevisionId &&
        existing.linkedAt === staged.linkedAt
      );
    });
    if (!canAcquire) {
      await done;
      return false;
    }
    links.forEach((link, index) => {
      if (current[index]?.pendingImport?.operationId !== link.pendingImport!.operationId) store.put(link);
    });
    await done;
    return true;
  }

  async compareAndSwapPendingLinks(
    expected: readonly { readonly id: string; readonly operationId: string }[],
    links: readonly ExternalSourceLink[],
    deleteIds: readonly string[],
  ): Promise<boolean> {
    if (expected.length === 0) return false;
    const db = await this.openDb();
    const tx = db.transaction('links', 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('links');
    const current = await Promise.all(
      expected.map(({ id }) => requestToPromise<ExternalSourceLink | undefined>(store.get(id))),
    );
    if (current.some((link, index) => link?.pendingImport?.operationId !== expected[index]?.operationId)) {
      await done;
      return false;
    }
    links.forEach((link) => store.put(link));
    deleteIds.forEach((id) => store.delete(id));
    await done;
    if (deleteIds.length > 0 || links.some((link) => !link.pendingImport)) this.publishSharedChange();
    return true;
  }

  async getDefaultFolder(
    connectorId: string,
    accountConnectionId?: string,
  ): Promise<ExternalSourceDefaultFolder | undefined> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readonly');
    return requestToPromise<ExternalSourceDefaultFolder | undefined>(
      tx.objectStore('browsePreferences').get(externalSourceDefaultFolderId(connectorId, accountConnectionId)),
    );
  }

  async saveDefaultFolder(folder: ExternalSourceDefaultFolder): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').put(folder);
    await transactionDone(tx);
  }

  async deleteDefaultFolder(connectorId: string, accountConnectionId?: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').delete(externalSourceDefaultFolderId(connectorId, accountConnectionId));
    await transactionDone(tx);
  }

  async getCatalogPreference(
    connectorId: string,
    accountConnectionId: string | undefined,
    parentRef: string,
  ): Promise<ExternalSourceCatalogPreference | undefined> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readonly');
    return requestToPromise<ExternalSourceCatalogPreference | undefined>(
      tx
        .objectStore('browsePreferences')
        .get(externalSourceCatalogPreferenceId(connectorId, accountConnectionId, parentRef)),
    );
  }

  async saveCatalogPreference(preference: ExternalSourceCatalogPreference): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('browsePreferences', 'readwrite');
    tx.objectStore('browsePreferences').put(preference);
    await transactionDone(tx);
  }

  async listSubscriptions(
    connectorId?: string,
    accountConnectionId?: string,
  ): Promise<ExternalSourceSubscriptionRecord[]> {
    const db = await this.openDb();
    const tx = db.transaction('subscriptions', 'readonly');
    const store = tx.objectStore('subscriptions');
    const records = connectorId
      ? await requestToPromise<ExternalSourceSubscriptionRecord[]>(
          store.index('connectorId').getAll(IDBKeyRange.only(connectorId)),
        )
      : await requestToPromise<ExternalSourceSubscriptionRecord[]>(store.getAll());
    return records
      .filter((record) => accountConnectionId === undefined || record.accountConnectionId === accountConnectionId)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  async saveSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('subscriptions', 'readwrite');
    tx.objectStore('subscriptions').put(subscription);
    await transactionDone(tx);
    this.publishSharedChange();
  }

  async deleteSubscription(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('subscriptions', 'readwrite');
    tx.objectStore('subscriptions').delete(id);
    await transactionDone(tx);
    this.publishSharedChange();
  }

  async listSelectedItems(connectorId: string, accountConnectionId: string): Promise<ExternalSourceSelectionRecord[]> {
    const db = await this.openDb();
    const tx = db.transaction('selectedItems', 'readonly');
    const records = await requestToPromise<ExternalSourceSelectionRecord[]>(
      tx.objectStore('selectedItems').index('connectorId').getAll(IDBKeyRange.only(connectorId)),
    );
    return records
      .filter((record) => record.accountConnectionId === accountConnectionId)
      .sort((left, right) => right.selectedAt.localeCompare(left.selectedAt) || left.id.localeCompare(right.id));
  }

  async saveSelectedItem(record: ExternalSourceSelectionRecord): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').put(record);
    await transactionDone(tx);
  }

  async deleteSelectedItem(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction('selectedItems', 'readwrite');
    tx.objectStore('selectedItems').delete(id);
    await transactionDone(tx);
  }

  async getSharedConnection(connectorId: string): Promise<ExternalSourceSharedConnectionV1 | undefined> {
    return this.sharedConnections.get(connectorId);
  }

  async saveSharedConnection(connection: ExternalSourceSharedConnectionV1): Promise<void> {
    this.sharedConnections.set(connection.connectorId, connection);
    this.publishSharedChange();
  }

  async deleteSharedConnection(connectorId: string): Promise<void> {
    this.sharedConnections.delete(connectorId);
    this.publishSharedChange();
  }

  async exportSharedState(): Promise<ExternalSourceSharedStateV1> {
    const releasePreferences = await this.listReleasePreferences();
    const db = await this.openDb();
    const tx = db.transaction(['links', 'subscriptions'], 'readonly');
    const [links, subscriptions] = await Promise.all([
      requestToPromise<ExternalSourceLink[]>(tx.objectStore('links').getAll()),
      requestToPromise<ExternalSourceSubscriptionRecord[]>(tx.objectStore('subscriptions').getAll()),
    ]);
    return {
      schemaVersion: 1,
      ...(releasePreferences.length ? { releasePreferences } : {}),
      connections: [...this.sharedConnections.values()].sort((left, right) =>
        left.connectorId.localeCompare(right.connectorId),
      ),
      links: links.filter((link) => !link.pendingImport).sort((left, right) => left.id.localeCompare(right.id)),
      subscriptions: subscriptions
        .map(({ thumbnailUrl: _deviceResolvedThumbnail, ...subscription }) => subscription)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async replaceSharedState(snapshot: ExternalSourceSharedStateV1): Promise<void> {
    const db = await this.openDb();
    const hasPreferences = db.objectStoreNames.contains('browsePreferences');
    if (!hasPreferences && snapshot.releasePreferences?.length)
      throw new Error('회차 설정 저장소를 사용할 수 없습니다.');
    const tx = db.transaction(
      ['links', 'subscriptions', ...(hasPreferences ? ['browsePreferences'] : [])],
      'readwrite',
    );
    const linkStore = tx.objectStore('links');
    const pendingLinks = (await requestToPromise<ExternalSourceLink[]>(linkStore.getAll())).filter(
      (link) => link.pendingImport,
    );
    const subscriptionStore = tx.objectStore('subscriptions');
    linkStore.clear();
    subscriptionStore.clear();
    snapshot.links.forEach((link) => linkStore.put(link));
    pendingLinks.forEach((link) => linkStore.put(link));
    snapshot.subscriptions.forEach((subscription) => subscriptionStore.put(subscription));
    if (hasPreferences) {
      const preferences = tx.objectStore('browsePreferences');
      const rows = await requestToPromise<SourceReleasePreference[]>(preferences.getAll(releasePreferencesRange()));
      rows.filter((row) => row.kind === 'releasePreference').forEach((row) => preferences.delete(row.id));
      snapshot.releasePreferences?.forEach((row) => preferences.put(row));
    }
    await transactionDone(tx);
    this.sharedConnections.clear();
    snapshot.connections.forEach((connection) => this.sharedConnections.set(connection.connectorId, connection));
  }
}

export async function resetExternalSourceLocalStateForTests(): Promise<void> {
  await Promise.all([...sourceDatabases.values()].map(async (promise) => (await promise).close()));
  const names = [...sourceDatabases.keys()];
  sourceDatabases.clear();
  credentialKeys.clear();
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
    request.onblocked = () => reject(new Error('External source database deletion is blocked.'));
  });
}

/** Metadata only; downloads, credentials and library links are deliberately outside this operation. */
export async function clearSourceMetadataCache(scope?: string): Promise<void> {
  const db = await openExternalSourceDb(scope ? `${DB_NAME}:account:${scope}` : DB_NAME);
  const tx = db.transaction('cachePages', 'readwrite');
  tx.objectStore('cachePages').clear();
  notifySourceCacheClear(scope);
  await transactionDone(tx);
}

/** Serialized payload estimate only, not IndexedDB overhead or the browser HTTP cache. */
export async function readSourceMetadataCacheUsage(scope?: string): Promise<{ bytes: number; entries: number }> {
  const db = await openExternalSourceDb(scope ? `${DB_NAME}:account:${scope}` : DB_NAME);
  const tx = db.transaction('cachePages', 'readonly');
  const done = transactionDone(tx);
  const pages = await requestToPromise<ExternalCatalogCachePage[]>(tx.objectStore('cachePages').getAll());
  await done;
  return {
    bytes: pages.reduce(
      (sum, page) => sum + (page.byteLength ?? new TextEncoder().encode(JSON.stringify(page)).length),
      0,
    ),
    entries: pages.length,
  };
}
