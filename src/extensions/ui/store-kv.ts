import type { UiMethodMap, UiResponse } from '@boaa/extension-contracts/ui-protocol';
import { UI_LIMITS, validateUiResponse } from '@boaa/extension-contracts/ui-protocol';
import { request } from './store-db';
import { authorize } from './store-installation';
import {
  UI_STORE_LIMITS,
  bytes,
  requireStore,
  namespaceUsage,
  profileUsage,
  type SessionBinding,
  type NamespaceUsage,
  type ProfileUsage,
  type KvRow,
  type ReceiptRow,
  type StorageMethod,
} from './store-model';
export interface PageCursor {
  after: string;
  sequence: number;
}
function listFits(items: UiMethodMap['storage.list']['result']['items']): boolean {
  return validateUiResponse(
    {
      wireVersion: 1,
      kind: 'response',
      sessionId: 's'.repeat(128),
      requestId: 'r'.repeat(128),
      ok: true,
      result: { items, nextCursor: 'c'.repeat(128) },
    },
    'storage.list',
  );
}
export async function readKv(
  tx: IDBTransaction,
  binding: SessionBinding,
  method: 'storage.get' | 'storage.list',
  params: UiMethodMap['storage.get']['params'] | UiMethodMap['storage.list']['params'],
  cursor?: PageCursor,
) {
  await authorize(tx, binding, 'storage.own');
  if (method === 'storage.get') {
    const row: KvRow | undefined = await request(
      tx
        .objectStore('kv')
        .get([binding.scope, binding.installationId, (params as UiMethodMap['storage.get']['params']).key]),
    );
    return {
      result: row ? { found: true as const, value: row.value, revision: row.revision } : { found: false as const },
    };
  }
  const { limit, prefix = '' } = params as UiMethodMap['storage.list']['params'];
  const usage: NamespaceUsage =
    (await request(tx.objectStore('usage').get(binding.installationId))) ?? namespaceUsage(binding.installationId);
  requireStore(!cursor || cursor.sequence === usage.sequence, 'STORAGE_CONFLICT');
  const rows: KvRow[] = await request(
    tx.objectStore('kv').index('namespace').getAll([binding.scope, binding.installationId]),
  );
  const eligible = rows
    .filter((r) => r.key.startsWith(prefix) && (!cursor || r.key > cursor.after))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const items: UiMethodMap['storage.list']['result']['items'] = [];
  for (const row of eligible) {
    const item = { key: row.key, value: row.value, revision: row.revision };
    if (items.length === limit || !listFits([...items, item])) break;
    items.push(item);
  }
  requireStore(items.length > 0 || eligible.length === 0, 'QUOTA_EXCEEDED');
  return {
    result: { items },
    next: items.length < eligible.length ? { after: items[items.length - 1].key, sequence: usage.sequence } : undefined,
  };
}
export async function writeKv<M extends 'storage.set' | 'storage.remove'>(
  tx: IDBTransaction,
  binding: SessionBinding,
  method: M,
  params: UiMethodMap[M]['params'],
  hash: string,
  receiptId: string,
  now: number,
): Promise<UiMethodMap[M]['result']> {
  const install = await authorize(tx, binding, 'storage.own');
  const kv = tx.objectStore('kv');
  const receipts = tx.objectStore('receipts');
  const usages = tx.objectStore('usage');
  const usage: NamespaceUsage =
    (await request(usages.get(binding.installationId))) ?? namespaceUsage(binding.installationId);
  const profile: ProfileUsage = (await request(usages.get('profile'))) ?? profileUsage();
  const oldBytes = usage.bytes;
  const allReceipts: ReceiptRow[] = await request(
    receipts.index('namespace').getAll([binding.scope, binding.installationId]),
  );
  const live = allReceipts.filter((r) => r.expiresAt > now);
  const previous = live.find((r) => r.key === params.idempotencyKey);
  if (previous) {
    requireStore(previous.hash === hash, 'STORAGE_CONFLICT');
    return { revision: previous.revision, receiptId: previous.receiptId };
  }
  requireStore(live.length < UI_STORE_LIMITS.receipts, 'QUOTA_EXCEEDED');
  for (const expired of allReceipts.filter((r) => r.expiresAt <= now)) {
    usage.bytes -= bytes(expired);
    receipts.delete([binding.scope, binding.installationId, expired.key]);
  }
  const rowKey = [binding.scope, binding.installationId, params.key];
  const old: KvRow | undefined = await request(kv.get(rowKey));
  requireStore((old?.revision ?? null) === params.expectedRevision, 'STORAGE_CONFLICT');
  requireStore(usage.sequence < Number.MAX_SAFE_INTEGER, 'QUOTA_EXCEEDED');
  const revision = ++usage.sequence;
  if (old) usage.bytes -= bytes(old);
  if (usage.bytes === 0)
    usage.bytes =
      bytes({
        scope: binding.scope,
        installationId: binding.installationId,
        usage: namespaceUsage(binding.installationId),
      }) + 128;
  if (method === 'storage.set') {
    const row: KvRow = {
      scope: binding.scope,
      installationId: binding.installationId,
      key: params.key,
      value: (params as UiMethodMap['storage.set']['params']).value,
      revision,
    };
    usage.bytes += bytes(row);
    if (!old) usage.entries++;
    kv.put(row);
  } else {
    requireStore(old, 'STORAGE_CONFLICT');
    usage.entries--;
    kv.delete(rowKey);
  }
  const receipt: ReceiptRow = {
    scope: binding.scope,
    installationId: binding.installationId,
    key: params.idempotencyKey,
    hash,
    revision,
    receiptId,
    expiresAt: now + UI_STORE_LIMITS.receiptTtlMs,
  };
  usage.bytes += bytes(receipt);
  receipts.put(receipt);
  profile.dataBytes += usage.bytes - oldBytes;
  requireStore(
    usage.entries <= UI_LIMITS.storageEntries &&
      usage.bytes <= install.manifest!.requestedAccess.storageKiB * 1024 &&
      profile.dataBytes <= UI_STORE_LIMITS.profileBytes,
    'QUOTA_EXCEEDED',
  );
  usages.put(usage);
  usages.put(profile);
  return { revision, receiptId };
}
/** Response envelope is also checked, not only each stored value. */
export function assertStorageResult<M extends StorageMethod>(method: M, result: UiMethodMap[M]['result']): void {
  const response: UiResponse<M> = {
    wireVersion: 1,
    kind: 'response',
    sessionId: 's'.repeat(128),
    requestId: 'r'.repeat(128),
    ok: true,
    result,
  };
  requireStore(validateUiResponse(response, method), 'QUOTA_EXCEEDED');
}
