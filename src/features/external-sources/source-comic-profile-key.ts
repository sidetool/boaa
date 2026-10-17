import { persistentId128 } from '@boaa/text-core/hash';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import { externalDocumentCollectionId } from '../../external-sources/series/document-series-identity';

/** Same work identity as the durable series importer, shared by all streamed/saved episodes. */
export function sourceComicProfileKey(item: ExternalItemSummary, fallback: string): string {
  if (!item.collection) return fallback;
  return item.collection.seriesProfile?.kind === 'document_series'
    ? externalDocumentCollectionId(item.key, item.collection.remoteId)
    : persistentId128('external_series', [
        [item.key.connectorId, item.key.accountConnectionId ?? '', item.collection.remoteId].join('::'),
      ]);
}
