import type { Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import {
  externalSourceSubscriptionId,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { SourceLibrarySnapshotPort } from './source-library-snapshot';
import { knownWorkTitle } from './source-work-metadata';

/** Give legacy source downloads with opaque titles a durable metadata target without fetching the network. */
export async function recoverLinkedWorkMetadata(
  options: SourceLibrarySnapshotPort,
  subscriptions: readonly ExternalSourceSubscriptionRecord[],
  links: readonly ExternalSourceLink[],
  novels: readonly Novel[],
) {
  const records = [...subscriptions];
  for (const link of links) {
    if (link.pendingImport || !link.collectionRemoteId) continue;
    const novel = novels.find((novel) => novel.id === link.localBookId && !novel.deletedAt);
    if (!novel || knownWorkTitle([novel.title], [link.collectionRemoteId, link.source.remoteId])) continue;
    const id = externalSourceSubscriptionId(
      link.source.connectorId,
      link.source.accountConnectionId,
      link.collectionRemoteId,
    );
    if (records.some((record) => record.id === id)) continue;
    const current = (await options.state.listSubscriptions()).find((record) => record.id === id);
    if (current) {
      records.push(current);
      continue;
    }
    const record: ExternalSourceSubscriptionRecord = {
      id,
      connectorId: link.source.connectorId,
      accountConnectionId: link.source.accountConnectionId,
      collectionRemoteId: link.collectionRemoteId,
      navigationRef: link.collectionRemoteId,
      title: '',
      titleUnknown: true,
      author: novel.author,
      knownReleaseIds: [],
      newReleaseIds: [],
      availableReleaseCount: 0,
      createdAt: novel.createdAt,
      updatedAt: novel.updatedAt,
      lastCheckedAt: novel.updatedAt,
      schemaVersion: 1,
    };
    try {
      await options.state.saveSubscription(record);
      records.push(record);
    } catch {
      /* Optional metadata recovery. */
    }
  }
  return records;
}
