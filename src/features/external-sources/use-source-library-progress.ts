import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { cachePageId } from '../../external-sources/cached-page';

import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
import { useSourceWorkProgress } from './use-source-work-progress';
import { sourceLibraryPosition, type SourceLibraryPosition } from './source-library-position';

/** Adds source-position data from local catalogue caches; never fetches the network from library/home. */
export function useSourceLibraryProgress(
  options: UseExternalSourceControllerOptions,
  input: Parameters<typeof useSourceWorkProgress>[0],
) {
  const paused = Boolean(options.readingActive);
  const base = useSourceWorkProgress({ ...input, paused });
  const latest = useRef({ options, input });
  latest.current = { options, input };
  const [snapshot, setSnapshot] = useState<{ key: string; positions: ReadonlyMap<string, SourceLibraryPosition> }>();
  const key = JSON.stringify([
    options.settingsScope,
    options.extensionRevision,
    options.libraryRevision,
    input.novels.map((n) => [
      n.id,
      n.format,
      n.lastReadChapterId,
      n.lastReadChapterIndex,
      n.lastReadAt,
      n.updatedAt,
      n.activeContentRevisionId,
    ]),
    input.links.map((l) => [l.localBookId, l.source, l.collectionRemoteId, l.pendingImport]),
    input.subscriptions.map((s) => [s.id, s.availableReleaseCount, s.updatedAt]),
  ]);
  useEffect(() => {
    if (paused) return;
    let active = true;
    const { options, input } = latest.current;
    void (async () => {
      const positions = new Map<string, SourceLibraryPosition>();
      for (const novel of input.novels) {
        if (!active) return;
        if (novel.format !== 'txt' || novel.deletedAt) continue;
        const links = input.links.filter((l) => l.localBookId === novel.id && l.collectionRemoteId && !l.pendingImport);
        const link = links[0];
        if (!link) continue;
        try {
          const connection = options.registry.getExternalSourceStatus(
            link.source.connectorId as ExtensionContributionId,
            options.hostContext,
          );
          const cached = await options.state.getCachePage(
            cachePageId(
              link.source.connectorId,
              link.source.accountConnectionId,
              { parentRef: link.collectionRemoteId, accountConnectionId: link.source.accountConnectionId },
              options.settingsScope,
              connection.connectionGeneration,
            ),
          );
          const subscription = input.subscriptions.find(
            (s) =>
              s.connectorId === link.source.connectorId &&
              s.accountConnectionId === link.source.accountConnectionId &&
              s.collectionRemoteId === link.collectionRemoteId,
          );
          const catalog = cached?.items.filter((item) => item.release) ?? [];
          const total = cached?.completeSeries ? catalog.length : (subscription?.availableReleaseCount ?? 0);
          if (!total) continue;
          const chapters = await input.listChapters(novel.id);
          const position = sourceLibraryPosition(novel, chapters, links, catalog, total);
          if (position) positions.set(novel.id, position);
        } catch {
          /* Local counts remain available when an extension/cache is unavailable. */
        }
      }
      if (active) setSnapshot({ key, positions });
    })();
    return () => {
      active = false;
    };
  }, [key, paused]);
  return useMemo(() => {
    if (snapshot?.key !== key) return base;
    const byNovelId = new Map(base.byNovelId);
    for (const [id, position] of snapshot.positions) {
      byNovelId.set(id, {
        ...byNovelId.get(id),
        readCount: position.position,
        totalCount: position.total,
        progress: position.progress,
        sourcePosition: position,
      });
    }
    return { ...base, byNovelId };
  }, [base, key, snapshot]);
}
