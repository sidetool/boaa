import { legacyBrandNames } from '@boaa/extension-contracts/brand-compat';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { PLUGIN_STATE_LIMITS } from '../../../packages/extension-contracts/plugin-state';
import { verifyPlatformPackage, verifyPlatformSingleJs } from '../packages/platform-package';
import { request } from '../ui/store-db';
import { bytes, canonicalJson, requireStore, scopeKey, UiStoreError, type UiPluginScope } from '../ui/store-model';
import type { ServerPluginDatabase } from './server-plugin-database';
import type { Installation, PayloadRow, ConfigRow, GrantRow, PlatformKvRow } from './store-model';
import { usage } from './store-transactions';

const databaseName = 'boaa.js-plugins.v1:default';
function legacyProfile(storage: Pick<Storage, 'getItem'>): string | undefined {
  for (const key of ['boaa.plugin-profile.v1', ...legacyBrandNames('boaa.plugin-profile.v1')]) {
    const value = storage.getItem(key);
    if (value && /^[a-f0-9-]{36}$/i.test(value)) return value;
  }
}
/** Open without schema upgrade, creating no legacy data and never deleting/modifying an old database. */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let blocked = false;
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name);
    } catch {
      resolve(undefined);
      return;
    }
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      if (blocked) req.result.close();
      else resolve(req.result);
    };
    req.onblocked = () => {
      blocked = true;
      resolve(undefined);
    };
  });
}
async function oldRead<T>(db: IDBDatabase, names: string[], read: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readonly');
    let result: T, failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? Error('LEGACY_READ_FAILED'));
    void read(tx)
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        failure = error;
        tx.abort();
      });
  });
}
async function verifyPayload(row: PayloadRow, pluginId: string) {
  const blob = row.blob instanceof Blob ? row.blob : new Blob([row.blob]);
  const verified = row.format === 'single-js' ? await verifyPlatformSingleJs(blob) : await verifyPlatformPackage(blob);
  requireStore(verified.digest === row.digest && verified.manifest.extension.id === pluginId, 'LEGACY_PACKAGE_INVALID');
  return {
    ...row,
    blob: await blob.arrayBuffer(),
    manifest: verified.manifest,
    publisher: verified.publisherFingerprint,
  };
}
export interface LegacyPluginMigrationResult {
  imported: number;
  skipped: number;
  failed: number;
  rollbackRetainedLocally: number;
}

/** Carry forward only this authenticated account's old browser scope. Server records, including removals,
 * always win. Original browser bytes remain intact as a recovery copy; guest code is never executed here. */
export async function migrateLegacyPlatformPlugins(options: {
  database: ServerPluginDatabase;
  newScope: Extract<UiPluginScope, { kind: 'remote' }>;
  storage: Pick<Storage, 'getItem'>;
  factory?: IDBFactory;
  signal?: AbortSignal;
  databaseNames?: readonly string[];
}): Promise<LegacyPluginMigrationResult> {
  const result: LegacyPluginMigrationResult = { imported: 0, skipped: 0, failed: 0, rollbackRetainedLocally: 0 };
  let profile: string | undefined;
  try {
    profile = legacyProfile(options.storage);
  } catch {
    return result;
  }
  const factory = options.factory ?? globalThis.indexedDB;
  if (!profile || !factory) return result;
  const oldScope = scopeKey({ ...options.newScope, profileId: profile }),
    newScope = scopeKey(options.newScope);
  if (oldScope === newScope) return result;
  const guard = () => requireStore(!options.signal?.aborted, 'CANCELLED');
  await options.database.refresh();
  for (const name of options.databaseNames ?? [databaseName, ...legacyBrandNames(databaseName)]) {
    guard();
    const db = await openExisting(factory, name);
    if (!db) continue;
    try {
      if (
        !['installations', 'archives', 'grants', 'config', 'usage'].every((store) =>
          db.objectStoreNames.contains(store),
        )
      )
        continue;
      const installations = await oldRead(db, ['installations'], async (tx) => {
        const store = tx.objectStore('installations').index('scope');
        requireStore((await request(store.count(oldScope))) <= 128, 'QUOTA_EXCEEDED');
        return request<Installation[]>(store.getAll(oldScope));
      });
      for (const legacy of installations) {
        guard();
        if (legacy.tombstone || !legacy.active) {
          result.skipped++;
          continue;
        }
        const existing = await options.database.run('readonly', guard, (tx) =>
          request(tx.objectStore('installations').get([newScope, legacy.pluginId])),
        );
        if (existing) {
          result.skipped++;
          continue;
        }
        try {
          const snapshot = await oldRead(
            db,
            ['archives', 'grants', 'config', 'usage', ...(db.objectStoreNames.contains('kv') ? ['kv'] : [])],
            async (tx) => ({
              active: await request<PayloadRow | undefined>(
                tx.objectStore('archives').get([oldScope, legacy.pluginId, legacy.active!]),
              ),
              previous: legacy.previous
                ? await request<PayloadRow | undefined>(
                    tx.objectStore('archives').get([oldScope, legacy.pluginId, legacy.previous]),
                  )
                : undefined,
              grant: await request<GrantRow | undefined>(tx.objectStore('grants').get([oldScope, legacy.pluginId])),
              config: await request<ConfigRow | undefined>(
                tx.objectStore('config').get([oldScope, legacy.installationId]),
              ),
              kv: db.objectStoreNames.contains('kv')
                ? await request<PlatformKvRow[]>(
                    tx.objectStore('kv').index('namespace').getAll([oldScope, legacy.installationId]),
                  )
                : [],
              counter: await request<{ sequence: number } | undefined>(
                tx.objectStore('usage').get(`kv:${legacy.installationId}`),
              ),
            }),
          );
          requireStore(snapshot.active, 'LEGACY_PACKAGE_MISSING');
          const active = await verifyPayload(snapshot.active, legacy.pluginId);
          requireStore(
            canonicalJson(active.manifest as unknown as UiJson) === canonicalJson(legacy.manifest as unknown as UiJson),
            'LEGACY_PACKAGE_INVALID',
          );
          let previous: Awaited<ReturnType<typeof verifyPayload>> | undefined;
          if (snapshot.previous)
            try {
              previous = await verifyPayload(snapshot.previous, legacy.pluginId);
            } catch {
              result.rollbackRetainedLocally++;
            }
          const estimatedBytes =
            Math.ceil(((active.blob.byteLength + (previous?.blob.byteLength ?? 0)) * 4) / 3) +
            bytes(snapshot.config ?? {}) +
            bytes(snapshot.kv) +
            256 * 1024;
          if (previous && estimatedBytes > PLUGIN_STATE_LIMITS.patchBytes) {
            previous = undefined;
            result.rollbackRetainedLocally++;
          }
          const installation: Installation = {
            ...legacy,
            scope: newScope,
            revision: 1,
            manifest: active.manifest,
            publisher: active.publisher,
          };
          if (previous) installation.previous = previous.digest;
          else delete installation.previous;
          const grant = snapshot.grant;
          if (installation.enabled)
            requireStore(
              grant &&
                grant.installationId === legacy.installationId &&
                grant.revision === legacy.revision &&
                grant.digest === legacy.active,
              'LEGACY_GRANT_INVALID',
            );
          const mapPayload = (row: Awaited<ReturnType<typeof verifyPayload>>): PayloadRow => ({
            scope: newScope,
            pluginId: legacy.pluginId,
            digest: row.digest,
            format: row.format,
            blob: row.blob,
            provenance: row.provenance,
          });
          const imported = await options.database.run('readwrite', guard, async (tx) => {
            if (await request(tx.objectStore('installations').get([newScope, legacy.pluginId]))) return false;
            const u = await usage(tx);
            u.installs++;
            const payloads = [mapPayload(active), ...(previous ? [mapPayload(previous)] : [])];
            u.archiveBytes += payloads.reduce((sum, row) => sum + (row.blob as ArrayBuffer).byteLength, 0);
            for (const row of payloads) tx.objectStore('archives').put(row);
            tx.objectStore('installations').put(installation);
            if (installation.enabled && grant) tx.objectStore('grants').put({ ...grant, scope: newScope, revision: 1 });
            if (snapshot.config) {
              tx.objectStore('config').put({ ...snapshot.config, scope: newScope });
              u.configBytes += bytes({ schema: snapshot.config.schema, value: snapshot.config.value });
            }
            if (snapshot.kv.length) {
              for (const row of snapshot.kv) tx.objectStore('kv').put({ ...row, scope: newScope });
              u.storageBytes =
                (u.storageBytes ?? 0) +
                snapshot.kv.reduce((sum, row) => sum + bytes({ key: row.key, value: row.value }), 0);
            }
            if (snapshot.kv.length || snapshot.counter)
              tx.objectStore('usage').put({
                id: `kv:${legacy.installationId}`,
                sequence: Math.max(snapshot.counter?.sequence ?? 0, ...snapshot.kv.map((row) => row.revision), 0),
              });
            tx.objectStore('usage').put(u);
            return true;
          });
          if (imported) result.imported++;
          else result.skipped++;
        } catch (error) {
          guard();
          if (error instanceof UiStoreError && error.code === 'STATE_CONFLICT') throw error;
          result.failed++;
        }
      }
    } catch (error) {
      guard();
      if (error instanceof UiStoreError && error.code === 'STATE_CONFLICT') throw error;
      result.failed++;
    } finally {
      db.close();
    }
  }
  return result;
}
