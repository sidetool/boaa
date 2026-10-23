import { UiPluginDatabase } from '../ui/store-db';
import { request } from '../ui/store-db';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore, UiStoreError } from '../ui/store-model';
import {
  PLUGIN_STATE_STORES,
  pluginStateKey,
  type PluginStateChange,
  type PluginStateDelta,
  type PluginStateKey,
  type PluginStateStore,
} from '../../../packages/extension-contracts/plugin-state';

type StoreName = PluginStateStore | 'runtime-markers';
type Row = Record<string, unknown>;
type Tables = Map<StoreName, Map<string, Row>>;
const keyText = (key: unknown) => JSON.stringify(key);
const indexes: Record<string, readonly string[]> = {
  scope: ['scope'],
  owner: ['scope', 'pluginId'],
  namespace: ['scope', 'installationId'],
};
function encoded(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
async function wireChange(change: PluginStateChange): Promise<PluginStateChange> {
  if (change.store !== 'archives' || !change.value) return change;
  const { blob, ...row } = change.value;
  const data = blob instanceof Blob ? await blob.arrayBuffer() : blob;
  requireStore(data instanceof ArrayBuffer, 'INVALID_STATE_ROW');
  return { ...change, value: { ...row, blobBase64: encoded(new Uint8Array(data)) } };
}
function decodeChange(change: PluginStateChange): PluginStateChange {
  if (!change.value || change.store !== 'archives') return change;
  const { blobBase64, ...row } = change.value;
  requireStore(typeof blobBase64 === 'string', 'INVALID_STATE_ROW');
  const binary = atob(blobBase64),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { ...change, value: { ...row, blob: bytes.buffer } };
}

/** Account data lives on the server. This adapter holds only a disposable in-memory working set.
 * Transactions are serialized, and writes are acknowledged only after the server's CAS commit.
 * Runtime markers are deliberately window-local; another device never inherits browser leases. */
export class ServerPluginDatabase extends UiPluginDatabase {
  private tables: Tables = new Map(
    [...PLUGIN_STATE_STORES, 'runtime-markers' as const].map((name) => [name, new Map()]),
  );
  private revision = 0;
  private loaded = false;
  private ended = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private active = new Map<AbortController, () => void>();
  constructor(private readonly options: { scope: string; transport?: typeof fetch; signal?: AbortSignal }) {
    super();
  }
  readonly getRevision = () => this.revision;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot undo an acknowledged server commit. */
      }
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private check() {
    requireStore(!this.ended && !this.options.signal?.aborted, 'CONTEXT_STALE');
  }
  private async send(method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal) {
    this.check();
    const signals = [this.options.signal, signal, AbortSignal.timeout(30_000)].filter((s): s is AbortSignal => !!s);
    let response: Response;
    try {
      response = await (this.options.transport ?? fetch)(
        `/api/plugins/state${method === 'GET' ? `?since=${this.revision}` : ''}`,
        {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'x-boaa-plugin-host': '1', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
        },
      );
    } catch {
      throw new UiStoreError(signal?.aborted ? 'CANCELLED' : 'STORAGE_UNAVAILABLE');
    }
    if (response.status === 409) throw new UiStoreError('STATE_CONFLICT');
    requireStore(response.ok, response.status === 413 ? 'QUOTA_EXCEEDED' : 'STORAGE_UNAVAILABLE');
    return response.json();
  }
  private apply(tables: Tables, change: PluginStateChange) {
    requireStore(PLUGIN_STATE_STORES.includes(change.store), 'INVALID_STATE_ROW');
    const table = tables.get(change.store)!;
    if (change.value) {
      requireStore(change.store === 'usage' || change.value.scope === this.options.scope, 'CONTEXT_STALE');
      requireStore(keyText(pluginStateKey(change.store, change.value)) === keyText(change.key), 'INVALID_STATE_ROW');
      table.set(keyText(change.key), change.value);
    } else table.delete(keyText(change.key));
  }
  private async load() {
    const delta = (await this.send('GET')) as PluginStateDelta;
    this.check();
    requireStore(
      Number.isSafeInteger(delta.revision) &&
        delta.revision >= 0 &&
        (delta.reset === true || delta.revision >= this.revision) &&
        Array.isArray(delta.changes),
      'INVALID_STATE_ROW',
    );
    const next = new Map(
      [...this.tables].map(([name, rows]) => [
        name,
        delta.reset && name !== 'runtime-markers' ? new Map<string, Row>() : new Map(rows),
      ]),
    );
    for (const change of delta.changes) this.apply(next, decodeChange(change));
    const changed = this.revision !== delta.revision;
    this.tables = next;
    this.revision = delta.revision;
    this.loaded = true;
    if (changed) this.publish();
  }
  refresh(): Promise<void> {
    return this.enqueue(() => this.load());
  }
  readPreference(key: 'reader-input'): Promise<UiJson | undefined> {
    return this.run(
      'readonly',
      () => this.check(),
      async (tx) => {
        const row = await request<Row | undefined>(tx.objectStore('preferences').get([this.options.scope, key]));
        return row?.value as UiJson | undefined;
      },
    );
  }
  writePreference(key: 'reader-input', value: UiJson): Promise<void> {
    return this.run(
      'readwrite',
      () => this.check(),
      async (tx) => {
        tx.objectStore('preferences').put({ scope: this.options.scope, key, value });
      },
    );
  }
  override invalidate() {
    for (const [abort, guard] of this.active)
      try {
        guard();
      } catch {
        abort.abort();
      }
  }
  override run<T>(mode: IDBTransactionMode, guard: () => void, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.check();
      guard();
      if (!this.loaded) await this.load();
      const next: Tables = new Map([...this.tables].map(([name, rows]) => [name, new Map(rows)]));
      const changes = new Map<string, PluginStateChange>();
      const abort = new AbortController();
      const check = () => {
        this.check();
        guard();
        requireStore(!abort.signal.aborted, 'CANCELLED');
      };
      this.active.set(abort, guard);
      const req = <V>(value: V): IDBRequest<V> => {
        const request = {
          result: structuredClone(value),
          error: null,
          onsuccess: null,
          onerror: null,
        } as unknown as IDBRequest<V>;
        queueMicrotask(() => request.onsuccess?.call(request, new Event('success')));
        return request;
      };
      const store = (name: StoreName): IDBObjectStore => {
        const rows = next.get(name);
        requireStore(rows, 'INVALID_STATE_ROW');
        const read = (query?: unknown, fields?: readonly string[]) =>
          [...rows.values()].filter((row) => {
            if (query === undefined || query === null) return true;
            const key = fields
              ? fields.length === 1
                ? row[fields[0]]
                : fields.map((field) => row[field])
              : pluginStateKey(name, row);
            return keyText(query) === keyText(key);
          });
        const mutate = (key: PluginStateKey, value?: Row) => {
          check();
          requireStore(mode === 'readwrite', 'READ_ONLY');
          if (value) rows.set(keyText(key), structuredClone(value));
          else rows.delete(keyText(key));
          if (name !== 'runtime-markers')
            changes.set(`${name}:${keyText(key)}`, {
              store: name,
              key,
              ...(value ? { value: structuredClone(value) } : {}),
            });
          return req(key);
        };
        return {
          get: (key: unknown) => req(rows.get(keyText(key))),
          getKey: (key: PluginStateKey) => req(rows.has(keyText(key)) ? key : undefined),
          getAll: (query?: unknown) => req(read(query)),
          count: (query?: unknown) => req(read(query).length),
          put: (value: Row) => mutate(pluginStateKey(name, value), value),
          delete: (key: PluginStateKey) => mutate(key),
          index: (index: string) => {
            requireStore(indexes[index], 'INVALID_STATE_ROW');
            return {
              get: (key: unknown) => req(read(key, indexes[index])[0]),
              getAll: (key?: unknown) => req(read(key, indexes[index])),
              count: (key?: unknown) => req(read(key, indexes[index]).length),
            };
          },
        } as unknown as IDBObjectStore;
      };
      try {
        const result = await work({ objectStore: store, abort: () => abort.abort() } as unknown as IDBTransaction);
        check();
        if (changes.size) {
          const response = await this.send(
            'POST',
            { expectedRevision: this.revision, changes: await Promise.all([...changes.values()].map(wireChange)) },
            abort.signal,
          );
          check();
          requireStore(response?.revision === this.revision + 1, 'INVALID_STATE_ROW');
          this.revision = response.revision;
        }
        this.tables = next;
        if (changes.size) this.publish();
        return result;
      } catch (error) {
        if (error instanceof UiStoreError && error.code === 'STATE_CONFLICT') await this.load();
        throw error;
      } finally {
        this.active.delete(abort);
      }
    });
  }
  override async close() {
    this.ended = true;
    for (const abort of this.active.keys()) abort.abort();
    this.tables.clear();
    this.listeners.clear();
  }
}
