import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Paragraph, ParagraphPage } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { ParagraphPageCache } from './paragraph-page-cache';
import { invalidateSharedParagraphPages, loadSharedParagraphPage } from './shared-paragraph-pages';

export interface ParagraphPagesController {
  readonly revision: number;
  readonly generation: number;
  readonly reset: () => void;
  readonly loadIndexes: (paragraphIndexes: readonly number[]) => Promise<void>;
  readonly prefetchAdjacent: (paragraphIndexes: readonly number[]) => void;
  readonly retryPage: (pageIndex: number) => Promise<void>;
  readonly prune: (visibleParagraphIndexes: readonly number[]) => void;
  readonly paragraphAt: (paragraphIndex: number) => Paragraph | undefined;
  readonly paragraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getParagraphAt: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly isPageFailed: (pageIndex: number) => boolean;
}

interface ChapterCache {
  readonly chapterId: string;
  readonly cache: ParagraphPageCache;
  readonly repository?: ReaderBodyRepository;
}

export class ParagraphPageCacheOwner {
  private active?: ChapterCache;
  private readonly stale: ParagraphPageCache[] = [];

  acquire(chapterId: string, factory: () => ParagraphPageCache, repository?: ReaderBodyRepository): ParagraphPageCache {
    if (this.active?.chapterId === chapterId && this.active.repository === repository) return this.active.cache;
    if (this.active) this.stale.push(this.active.cache);
    const cache = factory();
    this.active = { chapterId, cache, repository };
    return cache;
  }

  isActive(cache: ParagraphPageCache): boolean {
    return this.active?.cache === cache;
  }

  disposeStale(): void {
    this.stale.splice(0).forEach((cache) => cache.dispose());
  }

  dispose(): void {
    this.disposeStale();
    this.active?.cache.dispose();
    this.active = undefined;
  }
}

export function useParagraphPages(
  repository: ReaderBodyRepository,
  chapterId: string,
  paragraphCount: number,
  contentRevisionId?: string,
  openingPage?: ParagraphPage,
): ParagraphPagesController {
  const [, setPublishedRevision] = useState<{
    readonly cache: ParagraphPageCache;
    readonly revision: number;
  }>();
  const mountedRef = useRef(true);
  const ownerRef = useRef<ParagraphPageCacheOwner>();
  if (!ownerRef.current) ownerRef.current = new ParagraphPageCacheOwner();
  const owner = ownerRef.current;
  const publishCacheRevision = useCallback(
    (target: ParagraphPageCache) => {
      if (!mountedRef.current || !owner.isActive(target)) return;
      const revision = target.snapshot().revision;
      setPublishedRevision((current) =>
        current?.cache === target && current.revision === revision ? current : { cache: target, revision },
      );
    },
    [owner],
  );
  const cacheKey = JSON.stringify([chapterId, contentRevisionId]);
  const cache = owner.acquire(
    cacheKey,
    () => {
      const created = new ParagraphPageCache(PARAGRAPHS_PER_PAGE, () => {
        publishCacheRevision(created);
      });
      if (openingPage) created.seed(0, openingPage);
      return created;
    },
    repository,
  );
  const loadPage = useCallback(
    (id: string, pageIndex: number) =>
      contentRevisionId === undefined
        ? repository.getParagraphPage(id, pageIndex)
        : loadSharedParagraphPage(repository, contentRevisionId, id, pageIndex),
    [contentRevisionId, repository],
  );

  const loadIndexes = useCallback(
    async (indexes: readonly number[]) => {
      await cache.loadIndexes(chapterId, indexes, loadPage);
      // The cache callback normally publishes during the load. Publishing once more
      // after the promise settles closes the first-paint race where content is cached
      // between React's effect flush and the virtualizer's initial measurement.
      publishCacheRevision(cache);
    },
    [cache, chapterId, publishCacheRevision, loadPage],
  );

  const retryPage = useCallback(
    async (pageIndex: number) => {
      await cache.retryPage(chapterId, pageIndex, loadPage);
      publishCacheRevision(cache);
    },
    [cache, chapterId, publishCacheRevision, loadPage],
  );

  const getParagraphAt = useCallback(
    async (index: number) => {
      if (index < 0 || index >= paragraphCount) return undefined;
      const cached = cache.paragraphAt(index);
      if (cached) return cached;
      await loadIndexes([index]);
      return cache.paragraphAt(index);
    },
    [cache, loadIndexes, paragraphCount],
  );

  useEffect(() => {
    owner.disposeStale();
  }, [cache, owner]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React StrictMode immediately runs effect cleanup and setup once more in
      // development. Deferring disposal by one microtask keeps that probe from
      // destroying the active cache while still releasing it after a real
      // unmount.
      queueMicrotask(() => {
        if (!mountedRef.current) owner.dispose();
      });
    };
  }, [owner]);

  const snapshot = cache.snapshot();
  return useMemo(
    () => ({
      revision: snapshot.revision,
      generation: snapshot.generation,
      reset: () => {
        invalidateSharedParagraphPages(repository, chapterId);
        cache.reset();
      },
      loadIndexes,
      retryPage,
      prefetchAdjacent: (indexes: readonly number[]) => {
        if (!indexes.length) {
          cache.prefetchIndexes(chapterId, [], loadPage);
          return;
        }
        const first = Math.floor(Math.min(...indexes) / PARAGRAPHS_PER_PAGE);
        const last = Math.floor(Math.max(...indexes) / PARAGRAPHS_PER_PAGE);
        const neighbors = [(last + 1) * PARAGRAPHS_PER_PAGE, (first - 1) * PARAGRAPHS_PER_PAGE].filter(
          (index) => index >= 0 && index < paragraphCount,
        );
        cache.prefetchIndexes(chapterId, neighbors, loadPage);
      },
      prune: (indexes: readonly number[]) => cache.prune(indexes),
      paragraphAt: (index: number) => cache.paragraphAt(index),
      paragraphById: (paragraphId: string) => cache.paragraphById(paragraphId),
      getParagraphAt,
      isPageFailed: (pageIndex: number) => cache.isPageFailed(pageIndex),
    }),
    [
      cache,
      chapterId,
      paragraphCount,
      repository,
      getParagraphAt,
      loadIndexes,
      loadPage,
      retryPage,
      snapshot.generation,
      snapshot.revision,
    ],
  );
}
