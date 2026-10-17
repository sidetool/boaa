import { persistentId128 } from '@boaa/text-core/hash';
import type { ExternalItemKey } from '../contracts';

const sourceIds = new Map<string, string>();
const MAX_CACHED_SOURCE_IDS = 2048;

// Reader, outline and catalogue projections repeatedly derive the same immutable IDs.
// Bound retained keys; eviction affects CPU cost only, never persistent identity.
function sourceId(prefix: string, parts: string[]): string {
  const key = JSON.stringify([prefix, ...parts]);
  const cached = sourceIds.get(key);
  if (cached !== undefined) return cached;
  const id = persistentId128(prefix, parts);
  if (sourceIds.size >= MAX_CACHED_SOURCE_IDS) sourceIds.delete(sourceIds.keys().next().value!);
  sourceIds.set(key, id);
  return id;
}

export function externalDocumentCollectionId(
  key: Pick<ExternalItemKey, 'connectorId' | 'accountConnectionId'>,
  collectionRemoteId: string,
): string {
  return sourceId('external_series', [key.connectorId, key.accountConnectionId ?? '', collectionRemoteId]);
}

export function externalDocumentReleaseSourceId(key: ExternalItemKey, collectionRemoteId: string): string {
  return sourceId('external_release', [
    key.connectorId,
    key.accountConnectionId ?? '',
    collectionRemoteId,
    key.remoteId,
  ]);
}
