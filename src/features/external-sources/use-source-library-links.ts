import { useMemo } from 'react';
import type { Novel } from '../../domain/types';
import { externalItemKeyId, type ExternalSourceLink } from '../../external-sources/contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import type { ExternalSourceLibraryWork } from './external-source-controller-contract';

/** Projects source/local identities. Persistence and reconciliation belong to source-library-snapshot. */
export function useSourceLibraryLinks(
  links: readonly ExternalSourceLink[],
  novels: readonly Novel[],
  subscriptions: readonly ExternalSourceSubscriptionRecord[],
) {
  const linkByKey = useMemo(() => new Map(links.map((link) => [externalItemKeyId(link.source), link])), [links]);
  const novelById = useMemo(() => new Map(novels.map((novel) => [novel.id, novel])), [novels]);
  const unresolvedLibraryWorks = useMemo<readonly ExternalSourceLibraryWork[]>(() => {
    const knownNovelIds = new Set(novels.filter((novel) => !novel.deletedAt).map((novel) => novel.id));
    return subscriptions
      .filter((subscription) => {
        const related = links.filter(
          (link) =>
            link.source.connectorId === subscription.connectorId &&
            (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
            link.collectionRemoteId === subscription.collectionRemoteId,
        );
        return related.length === 0 || !related.every((link) => novelById.get(link.localBookId)?.deletedAt);
      })
      .map((subscription) => {
        const related = links.find(
          (link) =>
            link.source.connectorId === subscription.connectorId &&
            (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
            link.collectionRemoteId === subscription.collectionRemoteId &&
            knownNovelIds.has(link.localBookId),
        );
        return related ? { ...subscription, localBookId: related.localBookId } : subscription;
      });
  }, [links, novels, novelById, subscriptions]);

  return { linkByKey, novelById, unresolvedLibraryWorks };
}
