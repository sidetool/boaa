import { useEffect, useRef } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import {
  externalItemKeyId,
  type ExternalItemSummary,
  type ExternalSourceWorkDetail,
} from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

export interface StreamLibraryWorkInput {
  sourceId: ExtensionContributionId;
  accountConnectionId?: string;
  navigationRef: string;
  sourceNavigationRef?: string;
  detail: ExternalSourceWorkDetail;
  items: readonly ExternalItemSummary[];
  baselineComplete: boolean;
  signal?: AbortSignal;
}
/** A streamed work gets the same durable library record as an explicitly added work. */
export function useStreamLibraryContinuity(input: {
  item?: ExternalItemSummary;
  subscriptions: readonly ExternalSourceSubscriptionRecord[];
  detail?: ExternalSourceWorkDetail;
  sourceLabel?: string;
  items: readonly ExternalItemSummary[];
  complete: boolean;
  persist(input: StreamLibraryWorkInput): Promise<unknown>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const key = input.item?.collection
    ? externalItemKeyId({ ...input.item.key, remoteId: input.item.collection.remoteId })
    : undefined;
  useEffect(() => {
    if (!key) return;
    const current = latest.current;
    const item = current.item!;
    const collection = item.collection!;
    if (
      current.subscriptions.some(
        (work) =>
          work.connectorId === item.key.connectorId &&
          work.accountConnectionId === item.key.accountConnectionId &&
          work.collectionRemoteId === collection.remoteId,
      )
    )
      return;
    const abort = new AbortController();
    void current
      .persist({
        sourceId: item.key.connectorId as ExtensionContributionId,
        accountConnectionId: item.key.accountConnectionId,
        navigationRef: collection.remoteId,
        detail: current.detail
          ? { ...current.detail, sourceLabel: current.detail.sourceLabel ?? current.sourceLabel }
          : {
              title: collection.title,
              author: item.author,
              thumbnailUrl: item.thumbnailUrl,
              coverRef: item.coverRef,
              sourceLabel: current.sourceLabel,
            },
        items: current.items.length ? current.items : [item],
        baselineComplete: current.complete,
        signal: abort.signal,
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [key]);
}
