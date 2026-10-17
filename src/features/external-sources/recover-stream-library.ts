import { knownWorkTitle } from './source-work-metadata';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { cachePageId } from '../../external-sources/cached-page';
import {
  externalSourceSubscriptionId,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import type { SourceLibrarySnapshotPort } from './source-library-snapshot';
import { latestSourceVisits } from './source-release-reading';

/** Backfill historical streams from local history/cache only. Reset history and trashed records stay excluded. */
export async function recoverStreamLibrary(
  options: SourceLibrarySnapshotPort,
  subscriptions: readonly ExternalSourceSubscriptionRecord[],
  preferences: readonly SourceReleasePreference[],
): Promise<ExternalSourceSubscriptionRecord[]> {
  const result = [...subscriptions];
  for (const visit of latestSourceVisits(preferences).values()) {
    if (
      visit.readingMode !== 'stream' ||
      !visit.collectionRemoteId ||
      !visit.lastReadAt ||
      (visit.read === false && (visit.readChangedAt ?? visit.updatedAt) >= visit.lastReadAt)
    )
      continue;
    const source = visit.source;
    const id = externalSourceSubscriptionId(source.connectorId, source.accountConnectionId, visit.collectionRemoteId);
    if (result.some((work) => work.id === id)) continue;
    let generation: string | undefined;
    try {
      generation =
        options.registry && options.hostContext
          ? options.registry.getExternalSourceStatus(source.connectorId as ExtensionContributionId, options.hostContext)
              .connectionGeneration
          : undefined;
    } catch {
      /* An unavailable extension must not prevent restoring local history. */
    }
    const cached = await options.state
      .getCachePage(
        cachePageId(
          source.connectorId,
          source.accountConnectionId,
          { parentRef: visit.collectionRemoteId, accountConnectionId: source.accountConnectionId },
          options.settingsScope,
          generation,
        ),
      )
      .catch(() => undefined);
    const current = (await options.state.listSubscriptions()).find((work) => work.id === id);
    if (current) {
      result.push(current);
      continue;
    }
    const item = cached?.items.find((item) => item.collection?.remoteId === visit.collectionRemoteId);
    const title = knownWorkTitle(
      [cached?.detail?.title, visit.lastReadWork?.title, item?.collection?.title],
      [visit.collectionRemoteId],
    );
    const record: ExternalSourceSubscriptionRecord = {
      id,
      connectorId: source.connectorId,
      accountConnectionId: source.accountConnectionId,
      collectionRemoteId: visit.collectionRemoteId,
      navigationRef: visit.collectionRemoteId,
      title: title ?? '',
      titleUnknown: !title,
      author: cached?.detail?.author ?? visit.lastReadWork?.author ?? item?.author,
      thumbnailUrl: cached?.detail?.thumbnailUrl ?? item?.thumbnailUrl,
      sourceLabel:
        cached?.detail?.sourceLabel ??
        options.registry?.getExternalSources?.().find((entry) => entry.descriptor.id === source.connectorId)?.descriptor
          .title,
      knownReleaseIds: cached?.items.filter((item) => item.release).map((item) => item.key.remoteId) ?? [
        source.remoteId,
      ],
      newReleaseIds: [],
      availableReleaseCount: cached?.items.filter((item) => item.release).length ?? 0,
      releaseBaselineComplete: cached?.completeSeries ?? false,
      createdAt: visit.lastReadAt,
      updatedAt: visit.lastReadAt,
      lastCheckedAt: visit.lastReadAt,
      schemaVersion: 1,
    };
    try {
      await options.state.saveSubscription(record);
      result.push(record);
    } catch {
      /* A failed optional recovery must not hide the existing library. */
    }
  }
  return result;
}
