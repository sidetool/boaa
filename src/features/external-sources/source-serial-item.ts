import type { ExternalItemSummary } from '../../external-sources/contracts';
import type { ExternalSourceItemView } from './external-source-controller-contract';

export type SerialItemSummary = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;
export type SerialSourceItem = ExternalSourceItemView & SerialItemSummary;

export function isSerialSourceItem(item: ExternalSourceItemView): item is SerialSourceItem;
export function isSerialSourceItem(item: ExternalItemSummary): item is SerialItemSummary;
export function isSerialSourceItem(item: ExternalItemSummary): item is SerialItemSummary {
  return Boolean(item.collection?.remoteId && item.release?.title);
}

export function serialCollectionKey(item: SerialItemSummary): string {
  return [item.key.connectorId, item.key.accountConnectionId ?? '', item.collection.remoteId].join('::');
}
