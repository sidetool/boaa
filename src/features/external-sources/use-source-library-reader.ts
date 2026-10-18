import type { Chapter, Novel } from '../../domain/types';
import type { OpenReaderChapterOptions } from '../reader/reader-screen-contract';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { ExternalItemSummary } from '../../external-sources/contracts';

import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './external-source-controller-contract';
import { useSourceReaderCatalog } from './use-source-reader-catalog';
import { filterAndSortReleases } from './source-release-list-model';
import type { SourceLibraryPending } from './use-source-library-open';
import { preferTextLibrary } from './source-read-mode';
import { externalItemSectionId } from './serial-work-projection';
import { isTextSourceItem } from './source-read-mode';
import { prepareSourceLibraryImporter } from './prepare-source-library-importer';

export interface PreparedSourceLibraryChapter {
  readonly novel: Novel;
  readonly chapter: Chapter;
  readonly chapters: Chapter[];
}
export interface SourceLibraryReader {
  readonly novelId: string;
  readonly items: readonly ExternalSourceItemView[];
  readonly busy: boolean;
  readonly pending?: SourceLibraryPending;
  readonly error?: string;
  /** False means the requested episode did not open; the caller must retain its overlay. */
  open(item: ExternalSourceItemView, options?: OpenReaderChapterOptions): Promise<boolean | void>;
  retry(): Promise<void>;
  prepare?(item: ExternalSourceItemView): Promise<PreparedSourceLibraryChapter | undefined>;
}
/** Resolves a persisted text-series link after reload, then reuses the bounded/cached stream catalog loader. */
export function useSourceLibraryReader(
  options: UseExternalSourceControllerOptions,
  open: (item: ExternalSourceItemView, options?: OpenReaderChapterOptions) => Promise<boolean | void>,
  opening: boolean,
  prefetch?: (item: ExternalSourceItemView) => Promise<void | PreparedSourceLibraryChapter>,
  pending?: SourceLibraryPending,
): SourceLibraryReader | undefined {
  const openRef = useRef(open);
  openRef.current = open;
  const latest = useRef(options);
  latest.current = options;
  const target = options.readingTarget;
  const key =
    target && JSON.stringify([options.settingsScope, options.extensionRevision, target.novelId, target.sectionId]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [openError, setOpenError] = useState<{ key?: string; message: string }>();
  const failedOpen = useRef<{ key?: string; item: ExternalSourceItemView; options?: OpenReaderChapterOptions }>();
  const openItem = useCallback(async (item: ExternalSourceItemView, options?: OpenReaderChapterOptions) => {
    const request = { key: currentKey.current, item, options };
    setOpenError(undefined);
    failedOpen.current = undefined;
    try {
      return await (options ? openRef.current(item, options) : openRef.current(item));
    } catch (error) {
      if (request.key === currentKey.current) {
        failedOpen.current = request;
        setOpenError({ key: request.key, message: error instanceof Error ? error.message : String(error) });
      }
      return false;
    }
  }, []);
  const targetNovelId = target?.novelId;
  const targetSectionId = target?.sectionId;
  const [seed, setSeed] = useState<{ key: string; item?: ExternalItemSummary; error?: string }>();
  const [seedAttempt, setSeedAttempt] = useState(0);
  useEffect(() => {
    if (!key || !targetNovelId) return;
    let cancelled = false;
    const current = latest.current;
    void (async () => {
      const links = await current.state.listLinks();
      const link = links.find(
        (link) =>
          link.localBookId === targetNovelId &&
          link.collectionRemoteId &&
          !link.pendingImport &&
          (link.source.remoteId === targetSectionId ||
            externalDocumentReleaseSourceId(link.source, link.collectionRemoteId) === targetSectionId),
      );
      if (cancelled) return;
      if (!link) {
        setSeed({ key });
        return;
      }
      const novel = await current.getNovel(targetNovelId);
      if (cancelled) return;
      if (novel?.format !== 'txt') {
        setSeed({ key });
        return;
      }
      const item: ExternalItemSummary = {
        key: link.source,
        kind: 'file',
        formatHint: 'txt',
        title: link.source.remoteId,
        importability: 'supported',
        collection: { remoteId: link.collectionRemoteId!, title: link.collectionRemoteId! },
        release: { title: link.source.remoteId },
      };
      if (
        isTextSourceItem(item, current.registry.getSourceStream?.(link.source.connectorId as ExtensionContributionId))
      ) {
        if (preferTextLibrary(item)) void prepareSourceLibraryImporter().catch(() => undefined);
        setSeed({ key, item });
      } else setSeed({ key });
    })().catch((error) => {
      if (!cancelled) setSeed({ key, error: String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [key, targetNovelId, targetSectionId, options.state, options.registry, seedAttempt]);
  const item = seed?.key === key ? seed?.item : undefined;
  const catalog = useSourceReaderCatalog(item, options);
  const novelId = target?.novelId;
  const pages = catalog?.items;
  const loading = catalog?.loading;
  const error = catalog?.error;
  const retryCatalog = catalog?.retry;
  const retry = useCallback(async () => {
    const failed = failedOpen.current;
    if (failed && failed.key === currentKey.current) {
      await openItem(failed.item, failed.options);
      return;
    }
    if (retryCatalog) await retryCatalog();
    else setSeedAttempt((value) => value + 1);
  }, [openItem, retryCatalog]);
  const prefetchRef = useRef(prefetch);
  prefetchRef.current = prefetch;
  const prepare = useCallback(
    async (candidate: ExternalSourceItemView) => (await prefetchRef.current?.(candidate)) || undefined,
    [],
  );
  const model = useMemo(() => {
    if (!novelId || !key) return;
    if (!item) {
      if (seed?.key === key && !seed.error) return;
      return {
        novelId,
        items: [],
        busy: seed?.key !== key,
        error: seed?.key === key ? seed.error : undefined,
        pending,
        open: openItem,
        retry,
        prepare,
      };
    }
    const items = filterAndSortReleases(
      (pages ?? []).map((item) => ({
        ...item,
        selected: false,
        importState: item.importability === 'unsupported' ? ('unsupported' as const) : ('available' as const),
      })),
      '',
      'all',
      'asc',
    );
    return {
      novelId,
      items,
      busy: opening || Boolean(loading),
      pending,
      error: openError?.key === key ? openError.message : error,
      open: openItem,
      retry,
      prepare,
    };
  }, [item, novelId, pages, opening, loading, error, openError, retry, openItem, pending, key, seed, prepare]);
  const index =
    model?.items.findIndex(
      (entry) =>
        externalItemSectionId(entry) === targetSectionId ||
        (entry.collection && externalDocumentReleaseSourceId(entry.key, entry.collection.remoteId) === targetSectionId),
    ) ?? -1;
  const next = index >= 0 ? model?.items[index + 1] : undefined;
  const nextRef = useRef(next);
  nextRef.current = next;
  const nextKey = next && JSON.stringify(next.key);
  const attempted = useRef<string>();
  useEffect(() => {
    const candidate = nextRef.current;
    if (!candidate || !item || !preferTextLibrary(item)) return;
    const request = JSON.stringify([key, nextKey]);
    if (attempted.current === request || !prefetchRef.current) return;
    attempted.current = request;
    void prefetchRef.current(candidate).catch(() => {
      if (attempted.current === request) attempted.current = undefined;
    });
  }, [key, nextKey, item]);
  return model;
}
