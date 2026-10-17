import { isStreamDetailReturn, useSourceStreamEscape } from '../../ui-next/source/stream-navigation';
import { getHomeActive, setHomeActive, useHomeActive } from '../../ui-next/home/route';
import { getSearchRoute, setSearchRoute, useSearchRoute, type SearchRoute } from '../../ui-next/search/route';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Novel } from '../../domain/types';
import type { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import type { BookWorkspaceState } from '../book-workspace/book-workspace-contract';
import type {
  ExternalSourceController,
  ExternalSourceNavigationSnapshot,
} from '../external-sources/useExternalSourceController';
import { BrowserNavigation, installAppHistoryBack } from './browser-navigation';
import { openLibraryBook } from '../book-workspace/book-workspace-source-navigation';
import { restoreCurrentBookChapters } from './app-browser-reader-return';

type Snapshot = {
  search?: SearchRoute;
  home?: boolean;
  stream?: boolean;
  shelfId?: string;
  discovery?: boolean;
  view: BookWorkspaceState['view'];
  bookId?: string;
  detailBookId?: string;
  source?: ExternalSourceNavigationSnapshot;
  library: Pick<BookWorkspaceState, 'libraryQuery' | 'libraryFilter' | 'librarySort' | 'libraryViewMode'>;
  chapters: Pick<BookWorkspaceState, 'chapterQuery' | 'chapterReadFilter' | 'chapterSort'>;
  layers: readonly string[];
};

/** Opening/closing search must not cancel or reopen the workspace underneath it. */
function searchOnlyTransition(from: Snapshot, to: Snapshot) {
  return (
    from.search?.id !== to.search?.id &&
    JSON.stringify({ ...from, search: undefined }) === JSON.stringify({ ...to, search: undefined })
  );
}

export function useAppBrowserNavigation(options: {
  enabled: boolean;
  discovery?: { active: boolean; setActive(value: boolean): void };
  shelf?: { activeShelfId?: string; setActiveShelf(id?: string): void };
  workspace: BookWorkspaceController;
  state: BookWorkspaceState;
  sources: ExternalSourceController;
  getNovel(id: string): Promise<Novel | undefined>;
  layers?: readonly { id: string; open: boolean; dismiss(): void }[];
  notify(message: string): void;
}) {
  useHomeActive();
  useSearchRoute();
  useSourceStreamEscape(!getSearchRoute() && Boolean(options.sources.streaming), () => options.sources.closeStream?.());
  const streamReturn = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const history = useRef<BrowserNavigation<Snapshot>>();
  const capture = useCallback(() => {
    const { state, sources, layers } = latest.current;
    const source = state.view === 'library' && sources.open ? sources.captureNavigation?.() : undefined;
    const snapshot: Snapshot = {
      search: getSearchRoute(),
      stream: Boolean(sources.streaming),
      shelfId: latest.current.shelf?.activeShelfId,
      home: (state.view !== 'library' || (!sources.open && !latest.current.discovery?.active)) && getHomeActive(),
      discovery: latest.current.discovery?.active,
      view: state.view,
      bookId: state.selectedNovel?.id,
      source,
      library: {
        libraryQuery: state.libraryQuery,
        libraryFilter: state.libraryFilter,
        librarySort: state.librarySort,
        libraryViewMode: state.libraryViewMode,
      },
      chapters: {
        chapterQuery: state.chapterQuery,
        chapterReadFilter: state.chapterReadFilter,
        chapterSort: state.chapterSort,
      },
      layers: layers?.filter((layer) => layer.open && layer.id !== 'external-sources').map((layer) => layer.id) ?? [],
    };
    const key = snapshot.search
      ? JSON.stringify(['search', snapshot.search.id, snapshot.layers])
      : JSON.stringify([
          state.view,
          snapshot.discovery,
          snapshot.home,
          state.view === 'library' ? undefined : snapshot.bookId,
          source && [source.sourceId, source.localBookId, source.breadcrumbs.map((item) => item.parentRef)],
          snapshot.layers,
          snapshot.stream,
        ]);
    return { key, snapshot };
  }, []);

  useLayoutEffect(() => {
    if (!options.enabled) return;
    const navigation = new BrowserNavigation<Snapshot>({
      window,
      initial: capture(),
      capture,
      closesLayer: (from, to) =>
        from.discovery === to.discovery &&
        from.home === to.home &&
        from.view === to.view &&
        from.bookId === to.bookId &&
        from.source?.sourceId === to.source?.sourceId &&
        from.source?.localBookId === to.source?.localBookId &&
        JSON.stringify(from.source?.breadcrumbs) === JSON.stringify(to.source?.breadcrumbs) &&
        ((Boolean(from.search) && !to.search) ||
          (from.stream && !to.stream) ||
          (from.layers.length > to.layers.length && to.layers.every((id) => from.layers.includes(id)))),
      intermediate: (from, to) => {
        if (
          (to.view !== 'reader' && to.view !== 'document') ||
          (from.view === to.view && from.bookId === to.bookId) ||
          from.source ||
          (from.view === 'chapters' && from.bookId === to.bookId)
        )
          return;
        return {
          key: `detail:${to.bookId}`,
          snapshot: { ...to, view: 'chapters', detailBookId: to.bookId, layers: [] },
        };
      },
      cancelPending: (target, previous) => {
        if (searchOnlyTransition(previous, target)) return;
        streamReturn.current = Boolean(previous.stream) && isStreamDetailReturn(capture().snapshot, target);
        latest.current.workspace.cancelNavigation();
        if (!streamReturn.current) latest.current.sources.close();
      },
      settled: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
      onError: () => {
        setSearchRoute(undefined);
        latest.current.sources.close();
        latest.current.workspace.setView('library');
        latest.current.notify('이전 화면을 열지 못해 라이브러리로 돌아왔습니다.');
      },
      restore: async (target, signal) => {
        const searchOnly = searchOnlyTransition(capture().snapshot, target);
        setSearchRoute(target.search);
        if (searchOnly) return;
        const { workspace, sources } = latest.current;
        for (const layer of latest.current.layers ?? []) {
          if (layer.id !== 'external-sources' && layer.open && !target.layers.includes(layer.id)) layer.dismiss();
        }
        if (streamReturn.current) {
          sources.closeStream?.();
          return;
        }
        setHomeActive(Boolean(target.home));
        latest.current.discovery?.setActive(Boolean(target.discovery));
        const current = workspace.getSnapshot();
        const sameReader =
          (current.view === 'reader' || current.view === 'document') &&
          current.view === target.view &&
          current.selectedNovel?.id === target.bookId;
        if (sameReader) return;
        if (await restoreCurrentBookChapters(workspace, target)) return;
        if (current.view === 'reader' || current.view === 'document') await workspace.returnToChapters();
        signal.throwIfAborted();
        sources.close();
        if (target.view === 'library') {
          latest.current.shelf?.setActiveShelf(target.shelfId);
          workspace.setLibraryQuery(target.library.libraryQuery);
          workspace.setLibraryFilter(target.library.libraryFilter);
          workspace.setLibrarySort(target.library.librarySort);
          workspace.setLibraryViewMode(target.library.libraryViewMode);
          workspace.setView('library');
          if (target.source) await latest.current.sources.restoreNavigation?.(target.source);
        } else {
          const novel = target.bookId ? await latest.current.getNovel(target.bookId) : undefined;
          signal.throwIfAborted();
          if (!novel || novel.deletedAt) {
            workspace.setView('library');
            return;
          }
          if (target.detailBookId) await openLibraryBook(novel, workspace, latest.current.sources);
          else if (target.view === 'reader' || target.view === 'document') await workspace.continueReading(novel);
          else {
            await workspace.openNovel(novel, target.chapters);
          }
        }
      },
    });
    history.current = navigation;
    const removeBack = installAppHistoryBack(() => navigation.back());
    return () => {
      removeBack();
      navigation.dispose();
      history.current = undefined;
    };
  }, [options.enabled, capture]);

  useLayoutEffect(() => {
    if (!getSearchRoute() && (options.state.navigationPending || (options.sources.open && options.sources.loading)))
      return;
    history.current?.record(capture());
  });
}
