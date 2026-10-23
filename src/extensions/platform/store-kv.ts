import { uiKeys, uiRecord, uiString, uiInteger, isUiJson, type UiJson } from '@boaa/extension-contracts/ui-json';
import { UiPluginDatabase, request } from '../ui/store-db';
import { requireStore, bytes } from '../ui/store-model';
import { authorize, usage } from './store-transactions';
import type { PlatformStoreAccess } from './store-access';
import type { PlatformKvRow, PluginSession } from './store-model';
import { PLUGIN_STATE_LIMITS } from '../../../packages/extension-contracts/plugin-state';

export interface StorageGet {
  key: string;
}
export interface StorageSet extends StorageGet {
  value: UiJson;
  expectedRevision: number | null;
}
export interface StorageRemove extends StorageGet {
  expectedRevision: number;
}
export interface StorageList {
  prefix?: string;
  limit: number;
  cursor?: string;
}
const validKey = (key: unknown): key is string => uiString(key, 128);
const size = (row: PlatformKvRow) => bytes({ key: row.key, value: row.value });
export async function assertKvQuota(tx: IDBTransaction, scope: string, installationId: string, storageKiB: number) {
  const rows: PlatformKvRow[] = await request(tx.objectStore('kv').index('namespace').getAll([scope, installationId]));
  requireStore(rows.reduce((sum, row) => sum + size(row), 0) <= storageKiB * 1024, 'QUOTA_EXCEEDED');
}
interface NamespaceUsage {
  id: string;
  sequence: number;
}
export async function purgeKv(tx: IDBTransaction, scope: string, installationId: string) {
  const rows: PlatformKvRow[] = await request(tx.objectStore('kv').index('namespace').getAll([scope, installationId]));
  const u = await usage(tx);
  u.storageBytes = Math.max(0, (u.storageBytes ?? 0) - rows.reduce((sum, row) => sum + size(row), 0));
  tx.objectStore('usage').put(u);
  for (const row of rows) tx.objectStore('kv').delete([scope, installationId, row.key]);
  tx.objectStore('usage').delete(`kv:${installationId}`);
}
export class PlatformKvStore {
  constructor(
    private readonly db: UiPluginDatabase,
    private readonly access: Pick<PlatformStoreAccess, 'session'>,
  ) {}
  async get(
    session: PluginSession,
    input: StorageGet,
  ): Promise<{ found: false } | { found: true; value: UiJson; revision: number }> {
    requireStore(uiRecord(input) && uiKeys(input, ['key']) && validKey(input.key), 'INVALID_ARGUMENT');
    const { guard, binding } = this.access.session(session);
    requireStore(binding.role !== 'task', 'PERMISSION_DENIED');
    return this.db.run('readonly', guard, async (tx) => {
      const install = await authorize(tx, binding, 'storage.own');
      const row: PlatformKvRow | undefined = await request(
        tx.objectStore('kv').get([binding.scope, install.installationId, input.key]),
      );
      return row ? { found: true as const, value: row.value, revision: row.revision } : { found: false as const };
    });
  }
  async set(session: PluginSession, input: StorageSet) {
    requireStore(
      uiRecord(input) &&
        uiKeys(input, ['key', 'value', 'expectedRevision']) &&
        validKey(input.key) &&
        isUiJson(input.value, 48 * 1024) &&
        (input.expectedRevision === null || uiInteger(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1)),
      'INVALID_ARGUMENT',
    );
    return this.change(session, structuredClone(input), false);
  }
  async remove(session: PluginSession, input: StorageRemove) {
    requireStore(
      uiRecord(input) &&
        uiKeys(input, ['key', 'expectedRevision']) &&
        validKey(input.key) &&
        uiInteger(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1),
      'INVALID_ARGUMENT',
    );
    return this.change(session, { ...input, value: null }, true);
  }
  private async change(session: PluginSession, input: StorageSet, remove: boolean) {
    const { guard, binding } = this.access.session(session);
    requireStore(binding.role !== 'task', 'PERMISSION_DENIED');
    return this.db.run('readwrite', guard, async (tx) => {
      const install = await authorize(tx, binding, 'storage.own');
      const namespace = [binding.scope, install.installationId];
      const rows: PlatformKvRow[] = await request(tx.objectStore('kv').index('namespace').getAll(namespace));
      const old = rows.find((row) => row.key === input.key);
      requireStore((old?.revision ?? null) === input.expectedRevision, 'STORAGE_CONFLICT');
      const id = `kv:${install.installationId}`;
      const counter: NamespaceUsage = (await request(tx.objectStore('usage').get(id))) ?? { id, sequence: 0 };
      requireStore(counter.sequence < Number.MAX_SAFE_INTEGER, 'QUOTA_EXCEEDED');
      const revision = ++counter.sequence;
      const row: PlatformKvRow = {
        scope: binding.scope,
        installationId: install.installationId,
        key: input.key,
        value: input.value,
        revision,
      };
      const delta = (remove ? 0 : size(row)) - (old ? size(old) : 0);
      requireStore(
        rows.reduce((sum, r) => sum + size(r), 0) + delta <= install.manifest!.requestedAccess.storageKiB * 1024 &&
          rows.length + (remove ? -1 : old ? 0 : 1) <= PLUGIN_STATE_LIMITS.kvEntries,
        'QUOTA_EXCEEDED',
      );
      const u = await usage(tx);
      u.storageBytes = (u.storageBytes ?? 0) + delta;
      requireStore(u.storageBytes <= PLUGIN_STATE_LIMITS.kvBytes, 'QUOTA_EXCEEDED');
      if (remove) tx.objectStore('kv').delete([...namespace, input.key]);
      else tx.objectStore('kv').put(row);
      tx.objectStore('usage').put(u);
      tx.objectStore('usage').put(counter);
      return { revision };
    });
  }
  async list(
    session: PluginSession,
    input: StorageList,
  ): Promise<{ items: { key: string; revision: number }[]; nextCursor?: string }> {
    requireStore(
      uiRecord(input) &&
        uiKeys(input, ['limit'], ['prefix', 'cursor']) &&
        uiInteger(input.limit, 1, 128) &&
        (input.prefix === undefined || (typeof input.prefix === 'string' && input.prefix.length <= 128)) &&
        (input.cursor === undefined || validKey(input.cursor)),
      'INVALID_ARGUMENT',
    );
    const { guard, binding } = this.access.session(session);
    requireStore(binding.role !== 'task', 'PERMISSION_DENIED');
    return this.db.run('readonly', guard, async (tx) => {
      const install = await authorize(tx, binding, 'storage.own');
      const rows: PlatformKvRow[] = await request(
        tx.objectStore('kv').index('namespace').getAll([binding.scope, install.installationId]),
      );
      const filtered = rows
        .filter((row) => row.key.startsWith(input.prefix ?? '') && (!input.cursor || row.key > input.cursor))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const items: { key: string; revision: number }[] = [];
      let total = 1024;
      for (const { key, revision } of filtered.slice(0, input.limit)) {
        const item = { key, revision },
          length = bytes(item) + 1;
        if (total + length > 48 * 1024) break;
        items.push(item);
        total += length;
      }
      return { items, ...(filtered.length > items.length ? { nextCursor: items.at(-1)!.key } : {}) };
    });
  }
}
