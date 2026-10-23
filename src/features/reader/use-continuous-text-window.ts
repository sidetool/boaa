import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { Chapter } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { ContinuousTextWindow, type ContinuousTextSource } from './continuous-text-window';
import type { ParagraphPagesController } from './use-paragraph-pages';

export function useContinuousTextWindow(
  enabled: boolean,
  repository: ReaderBodyRepository,
  chapter: Chapter,
  chapters: readonly Chapter[],
  revision: string,
  source?: ContinuousTextSource,
) {
  const [, publish] = useReducer((value) => value + 1, 0);
  const latest = useRef({ chapter, chapters, source });
  latest.current = { chapter, chapters, source };
  const mounted = useRef(true);
  const leases = useRef(new Map<ContinuousTextWindow, number>());
  const window = useMemo(
    () =>
      enabled
        ? new ContinuousTextWindow(
            { chapter: latest.current.chapter, repository },
            {
              neighbor: async (id, direction, signal) => {
                if (latest.current.source) return latest.current.source.neighbor(id, direction, signal);
                const list = latest.current.chapters;
                const at = list.findIndex((item) => item.id === id);
                const next = at < 0 ? undefined : list[at + direction];
                signal.throwIfAborted();
                return next ? { chapter: next, repository } : undefined;
              },
              retain: (ids) => latest.current.source?.retain?.(ids),
            },
            revision,
            () => {
              if (mounted.current) publish();
            },
          )
        : undefined,
    [enabled, repository, revision],
  );
  useEffect(() => {
    mounted.current = true;
    if (window) leases.current.set(window, (leases.current.get(window) ?? 0) + 1);
    const owners = leases.current;
    return () => {
      mounted.current = false;
      if (!window) return;
      owners.set(window, (owners.get(window) ?? 1) - 1);
      queueMicrotask(() => {
        if (!owners.get(window)) {
          window.dispose();
          owners.delete(window);
        }
      });
    };
  }, [window]);
  const version = window?.revision;
  const pages = useMemo<ParagraphPagesController | undefined>(
    () =>
      window
        ? {
            revision: version ?? 0,
            generation: 0,
            reset: () => window.reset(),
            paragraphAt: (index) => window.paragraphAt(index),
            paragraphById: (id) => window.paragraphById(id),
            loadIndexes: (indexes) => window.loadIndexes(indexes),
            getParagraphAt: (index) => window.getParagraphAt(index),
            prefetchAdjacent: (indexes) => window.prefetchAdjacent(indexes),
            prune: (indexes) => window.prune(indexes),
            retryPage: (index) => window.retryPage(index),
            isPageFailed: (index) => window.isPageFailed(index),
          }
        : undefined,
    [window, version],
  );
  return { window, pages };
}
