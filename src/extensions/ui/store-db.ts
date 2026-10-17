import { prepareBrandDatabase } from '../../storage/brand-database';
import { UiStoreError } from './store-model';
export const UI_STORES = ['installations', 'archives', 'grants', 'kv', 'usage', 'receipts', 'runtime-markers'] as const;
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new UiStoreError(req.error?.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : 'STORAGE_UNAVAILABLE'));
  });
}
/** Shared transaction engine; callers may provide an isolated schema in another database. */
export interface PluginDatabaseLayout {
  readonly stores: readonly string[];
  initialize(db: IDBDatabase): void;
}
export class UiPluginDatabase {
  private database?: Promise<IDBDatabase>;
  private transactions = new Map<IDBTransaction, () => void>();
  constructor(
    private readonly factory?: IDBFactory,
    private readonly name = 'boaa.ui-plugins.v1',
    private readonly layout?: PluginDatabaseLayout,
  ) {}
  private open(): Promise<IDBDatabase> {
    if (!this.database)
      this.database = prepareBrandDatabase(this.factory ?? globalThis.indexedDB, this.name).then(
        () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            let failed = false;
            const factory = this.factory ?? globalThis.indexedDB;
            if (!factory) throw new UiStoreError('STORAGE_UNAVAILABLE');
            const req = factory.open(this.name, 1);
            const fail = () => {
              failed = true;
              this.database = undefined;
              reject(new UiStoreError('STORAGE_UNAVAILABLE'));
            };
            req.onerror = fail;
            req.onblocked = fail;
            req.onupgradeneeded = () => {
              if (failed) {
                req.transaction?.abort();
                return;
              }
              const db = req.result;
              if (this.layout) {
                this.layout.initialize(db);
                return;
              }
              db.createObjectStore('installations', { keyPath: ['scope', 'pluginId'] }).createIndex('scope', 'scope');
              db.createObjectStore('archives', { keyPath: ['scope', 'pluginId', 'digest'] }).createIndex('owner', [
                'scope',
                'pluginId',
              ]);
              db.createObjectStore('grants', { keyPath: ['scope', 'pluginId'] });
              for (const name of ['kv', 'receipts'])
                db.createObjectStore(name, { keyPath: ['scope', 'installationId', 'key'] }).createIndex('namespace', [
                  'scope',
                  'installationId',
                ]);
              db.createObjectStore('usage', { keyPath: 'id' });
              db.createObjectStore('runtime-markers', {
                keyPath: ['scope', 'installationId', 'instanceId'],
              }).createIndex('scope', 'scope');
            };
            req.onsuccess = () => {
              const db = req.result;
              if (failed) {
                db.close();
                return;
              }
              db.onversionchange = () => {
                db.close();
                this.database = undefined;
              };
              db.onclose = () => {
                this.database = undefined;
              };
              resolve(db);
            };
          }),
      );
    const pending = this.database;
    void pending.catch(() => {
      if (this.database === pending) this.database = undefined;
    });
    return pending;
  }
  invalidate(): void {
    for (const [tx, guard] of this.transactions) {
      try {
        guard();
      } catch {
        try {
          tx.abort();
        } catch {
          /* Already committed. */
        }
      }
    }
  }
  /** The callback may await IDB requests only, never crypto, network or timers. */
  async run<T>(mode: IDBTransactionMode, guard: () => void, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    guard();
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch {
      throw new UiStoreError('STORAGE_UNAVAILABLE');
    }
    guard();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction([...(this.layout?.stores ?? UI_STORES)], mode, { durability: 'strict' });
      } catch {
        reject(new UiStoreError('STORAGE_UNAVAILABLE'));
        return;
      }
      this.transactions.set(tx, guard);
      let result: T;
      let failure: unknown;
      let finished = false;
      tx.oncomplete = () => {
        this.transactions.delete(tx);
        try {
          guard();
          if (!finished) throw new UiStoreError('STORAGE_UNAVAILABLE');
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      tx.onabort = () => {
        this.transactions.delete(tx);
        try {
          guard();
        } catch (error) {
          failure ??= error;
        }
        reject(
          failure instanceof UiStoreError
            ? failure
            : new UiStoreError(
                tx.error?.name === 'QuotaExceededError' ||
                  (failure instanceof DOMException && failure.name === 'QuotaExceededError')
                  ? 'QUOTA_EXCEEDED'
                  : 'STORAGE_UNAVAILABLE',
              ),
        );
      };
      void work(tx)
        .then((value) => {
          guard();
          result = value;
          finished = true;
        })
        .catch((error: unknown) => {
          failure = error;
          try {
            tx.abort();
          } catch {
            reject(error instanceof UiStoreError ? error : new UiStoreError('STORAGE_UNAVAILABLE'));
          }
        });
    });
  }
  async close(): Promise<void> {
    const db = this.database;
    this.database = undefined;
    if (db) (await db).close();
  }
}
