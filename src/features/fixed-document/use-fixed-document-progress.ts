import { registerReaderBoundaryFlush } from '../reader/use-reader-lifecycle-flush';
import type { ComicViewportPosition } from './use-comic-viewport-position';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Chapter, Novel } from '../../domain/types';
import { DebouncedProgressPersistence, sharedReaderPositionPersistence } from '../reader/reader-progress-controller';

export function useFixedDocumentProgress(
  pageIndex: number,
  chapter: Chapter | undefined,
  novel: Novel,
  save: (pageIndex: number, chapter: Chapter, novel: Novel, position?: ComicViewportPosition) => void | Promise<void>,
  options: {
    ready?: boolean;
    owner?: object;
    position?: ComicViewportPosition;
    readPosition?: () => ComicViewportPosition | undefined;
  } = {},
): () => Promise<void> {
  const latest = useRef({ pageIndex, chapter, novel, save, options });
  latest.current = { pageIndex, chapter, novel, save, options };
  const persistence = useMemo(
    () =>
      new DebouncedProgressPersistence<() => void | Promise<void>>(
        { set: (callback, delay) => window.setTimeout(callback, delay), clear: (id) => window.clearTimeout(id) },
        350,
        async (commit) => {
          await commit();
        },
        options.owner ? sharedReaderPositionPersistence(options.owner) : undefined,
      ),
    [options.owner],
  );
  const scheduled = useRef<string>();
  const scheduleLatest = useCallback(() => {
    const current = latest.current;
    if (!current.chapter || current.options.ready === false) return;
    const position = current.options.readPosition?.() ?? current.options.position;
    const key = JSON.stringify([
      current.novel.id,
      current.novel.activeContentRevisionId,
      current.chapter.id,
      current.pageIndex,
      position?.page,
      position?.fraction,
    ]);
    if (scheduled.current === key) return;
    scheduled.current = key;
    const chapter = current.chapter;
    persistence.schedule(() =>
      position
        ? current.save(current.pageIndex, chapter, current.novel, position)
        : current.save(current.pageIndex, chapter, current.novel),
    );
  }, [persistence]);
  const flush = useCallback(() => {
    scheduleLatest();
    return persistence.flush();
  }, [persistence, scheduleLatest]);
  useEffect(() => registerReaderBoundaryFlush(flush), [flush]);
  useEffect(scheduleLatest, [
    pageIndex,
    chapter?.id,
    novel.id,
    novel.activeContentRevisionId,
    options.ready,
    options.position?.fraction,
    options.position?.page,
    scheduleLatest,
  ]);
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => {
      void flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      void flush();
    };
  }, [flush]);
  return flush;
}
