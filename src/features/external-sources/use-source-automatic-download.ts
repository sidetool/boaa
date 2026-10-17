import { useRef } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { externalItemKeyId, type ExternalItemSummary } from '../../external-sources/contracts';
import { cachePageId, saveSourceCache } from '../../external-sources/cached-page';
import { sourceCachePolicy, sourcePageTime } from '../../external-sources/cache-policy';
import { filterAndSortReleases } from './source-release-list-model';
import { externalItemSectionId } from './serial-work-projection';
import { completeSeriesCatalog } from './complete-series-catalog';
import { isSerialSourceItem, type SerialSourceItem } from './source-serial-item';
import { queryFingerprint } from './source-catalog-query-values';
import { useNextReleaseDownload } from './use-next-release-download';
import { useSourceCommandScope } from './use-source-command-scope';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
type DownloadOptions = Pick<
  UseExternalSourceControllerOptions,
  | 'registry'
  | 'state'
  | 'settingsScope'
  | 'extensionRevision'
  | 'hostContext'
  | 'notify'
  | 'readingTarget'
  | 'downloadPolicy'
  | 'updateDownloadPolicy'
  | 'listChapters'
>;
const cacheSafeItems = (items: readonly ExternalItemSummary[]) =>
  items.map((item) => (item.thumbnailUrl?.startsWith('blob:') ? { ...item, thumbnailUrl: undefined } : item));
/** Metadata preparation owns cancellation until the existing durable download queue accepts the batch. */
export function useSourceAutomaticDownload(input: {
  options: DownloadOptions;
  streamItem?: ExternalItemSummary;
  busy: boolean;
  queue: {
    canAccept(): boolean;
    enqueue(
      sourceId: ExtensionContributionId,
      items: readonly SerialSourceItem[],
      signal: AbortSignal,
    ): Promise<unknown>;
  };
}) {
  const latest = useRef(input);
  latest.current = input;
  const { owner, capture } = useSourceCommandScope(input.options);
  const scheduler = useNextReleaseDownload({
    scope: owner,
    policy: input.options.downloadPolicy,
    updatePolicy: input.options.updateDownloadPolicy,
    readingKey: input.streamItem
      ? `stream:${externalItemKeyId(input.streamItem.key)}`
      : input.options.readingTarget
        ? JSON.stringify([input.options.readingTarget.novelId, input.options.readingTarget.sectionId])
        : undefined,
    busy: input.busy,
    reportError: () => {
      if (capture()())
        latest.current.options.notify(
          '다음 회차를 자동 다운로드하지 못했습니다. 회차 목록에서 다시 시도할 수 있습니다.',
          'warning',
        );
    },
    run: async (signal, count) => {
      const active = capture();
      if (!active()) return;
      const current = latest.current.options;
      const check = () => {
        signal.throwIfAborted();
        if (!active()) throw new DOMException('Source owner changed', 'AbortError');
      };
      const target = current.readingTarget;
      const streamItem = latest.current.streamItem;
      if (!target && !streamItem) return;
      const allLinks = await current.state.listLinks();
      check();
      const link = streamItem
        ? (allLinks.find((link) => externalItemKeyId(link.source) === externalItemKeyId(streamItem.key)) ??
          allLinks.find(
            (link) =>
              link.collectionRemoteId === streamItem.collection?.remoteId &&
              link.source.connectorId === streamItem.key.connectorId &&
              link.source.accountConnectionId === streamItem.key.accountConnectionId,
          ))
        : allLinks.find((link) => link.localBookId === target!.novelId && link.collectionRemoteId);
      const collectionRemoteId = streamItem?.collection?.remoteId ?? link?.collectionRemoteId;
      const source = streamItem?.key ?? link?.source;
      if (!source || !collectionRemoteId) return;
      const sourceId = source.connectorId as ExtensionContributionId;
      const context = current.hostContext;
      const connection = current.registry.getExternalSourceStatus(sourceId, latest.current.options.hostContext);
      if (connection.state !== 'connected' || connection.accountConnectionId !== source.accountConnectionId) return;
      const input = { parentRef: collectionRemoteId };
      const id = cachePageId(
        sourceId,
        connection.accountConnectionId,
        input,
        current.settingsScope,
        connection.connectionGeneration,
      );
      const cached = await current.state.getCachePage(id);
      check();
      const afterCache = current.registry.getExternalSourceStatus(sourceId, latest.current.options.hostContext);
      if (
        afterCache.state !== 'connected' ||
        afterCache.accountConnectionId !== connection.accountConnectionId ||
        afterCache.connectionGeneration !== connection.connectionGeneration
      )
        return;
      const cachedCatalogIsFresh =
        cached?.completeSeries === true && !cached.nextCursor && Date.parse(cached.expiresAt) > Date.now();
      let catalog = cachedCatalogIsFresh ? cached.items : undefined;
      if (!catalog) {
        const read = (cursor?: string) =>
          current.registry.listExternalSource(sourceId, context, { ...input, cursor }, signal);
        const page = await completeSeriesCatalog(await read(), (cursor) => read(cursor), signal);
        catalog = page.items;
        check();
        const latestConnection = current.registry.getExternalSourceStatus(sourceId, latest.current.options.hostContext);
        if (
          latestConnection.state !== 'connected' ||
          latestConnection.connectionGeneration !== connection.connectionGeneration ||
          latestConnection.accountConnectionId !== connection.accountConnectionId
        )
          return;
        await saveSourceCache(current.state, {
          id,
          connectorId: sourceId,
          accountConnectionId: connection.accountConnectionId,
          queryFingerprint: queryFingerprint(input),
          items: cacheSafeItems(catalog),
          completeSeries: true,
          detail: page.detail ? { ...page.detail, thumbnailUrl: undefined } : undefined,
          fetchedAt: new Date(sourcePageTime(page)).toISOString(),
          expiresAt: new Date(sourcePageTime(page) + sourceCachePolicy(input).fresh).toISOString(),
          retainUntil: new Date(sourcePageTime(page) + sourceCachePolicy(input).keep).toISOString(),
          scope: current.settingsScope,
          schemaVersion: 1,
        });
      }
      check();
      const currentConnection = current.registry.getExternalSourceStatus(sourceId, latest.current.options.hostContext);
      if (
        currentConnection.state !== 'connected' ||
        currentConnection.connectionGeneration !== connection.connectionGeneration ||
        currentConnection.accountConnectionId !== connection.accountConnectionId
      )
        return;
      const ordered = filterAndSortReleases(
        catalog
          .filter((item) => item.release && item.collection?.remoteId === collectionRemoteId)
          .map((item) => ({ ...item, selected: false, importState: 'available' as const })),
        '',
        'all',
        'asc',
      );
      const index = ordered.findIndex((item) =>
        streamItem
          ? externalItemKeyId(item.key) === externalItemKeyId(streamItem.key)
          : externalItemSectionId(item) === target!.sectionId,
      );
      if (index < 0) return;
      const upcoming = ordered.slice(index + 1, index + 1 + count);
      // Check the active stored chapters, including downloads completed while metadata was loading.
      const novelId = streamItem ? link?.localBookId : target!.novelId;
      const chapters = novelId ? await current.listChapters(novelId) : [];
      check();
      const finalConnection = current.registry.getExternalSourceStatus(sourceId, latest.current.options.hostContext);
      if (
        finalConnection.state !== 'connected' ||
        finalConnection.connectionGeneration !== connection.connectionGeneration ||
        finalConnection.accountConnectionId !== connection.accountConnectionId
      )
        return;
      const next = upcoming.filter(
        (item): item is SerialSourceItem =>
          isSerialSourceItem(item) &&
          item.importability !== 'unsupported' &&
          !chapters.some((chapter) => chapter.documentSectionId === externalItemSectionId(item)),
      );
      if (!next.length) return;
      check();
      // A manual job owns the queue if it started during the metadata request.
      if (!latest.current.queue.canAccept()) return;
      // Once accepted, a streaming background download belongs to the queue, not
      // to the episode on screen. Moving ahead must not cancel that download.
      await latest.current.queue.enqueue(sourceId, next, signal);
    },
  });
  return {
    ...scheduler,
    setEnabled(value: boolean) {
      if (capture()()) scheduler.setEnabled(value);
    },
    setCount(value: Parameters<typeof scheduler.setCount>[0]) {
      if (capture()()) scheduler.setCount(value);
    },
  };
}
