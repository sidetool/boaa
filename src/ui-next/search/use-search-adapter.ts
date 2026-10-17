import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { normalizeRecentSearches } from '@boaa/reader-core/settings';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { externalItemKeyId } from '../../external-sources/contracts';
import type { LibraryScreenProps } from '../../features/library/library-screen-contract';
import { orderedLibraryWorks } from '../../features/library/library-work-order';
import { rememberDiscoverySourceDestination } from '../../features/discovery/source-view-navigation';
import { createUiNextLibraryAdapter } from '../library/model';
import type { HomeAdapterInput } from '../home/model';
import { setHomeActive } from '../home/route';
import type { UiNextSearchAdapter } from './contract';
import type { SearchData } from './data';
import { searchLibrary } from './library-search';
import { SourceSearch, type SearchSource } from './source-search';
import { setSearchRoute } from './route';

export function useSearchAdapter(
  props: LibraryScreenProps,
  catalog?: Pick<HomeAdapterInput, 'books' | 'externalWorks'>,
  data?: SearchData,
): UiNextSearchAdapter {
  const session = data?.discovery?.session;
  const sourceKey = JSON.stringify(
    (data?.externalSources.sources ?? [])
      .filter(
        (source) =>
          source.connection.state === 'connected' &&
          session?.registry
            .getExternalSources()
            .some(({ descriptor }) => descriptor.id === source.id && descriptor.capabilities.includes('search')),
      )
      .map(({ id, title }) => ({ id, title, identity: session!.key(id, { browseMode: 'search' }) })),
  );
  const store = useMemo(() => new SourceSearch(session, JSON.parse(sourceKey) as SearchSource[]), [session, sourceKey]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => () => store.cancel(), [store]);
  const books = useMemo(
    () => catalog?.books ?? [...props.model.collection.booksByNovelId.values()],
    [catalog?.books, props.model.collection.booksByNovelId],
  );
  const externalWorks = useMemo(
    () => catalog?.externalWorks ?? props.model.externalSources.libraryWorks ?? [],
    [catalog?.externalWorks, props.model.externalSources.libraryWorks],
  );
  const works = useMemo(
    () => orderedLibraryWorks(books, externalWorks, 'recent', props.model.externalSources.bookReadingActivity),
    [books, externalWorks, props.model.externalSources.bookReadingActivity],
  );
  const leave = () => setSearchRoute(undefined);
  const libraryHelpers = createUiNextLibraryAdapter({
    ...props,
    model: {
      ...props.model,
      management: { ...props.model.management, selectionMode: false },
      collection: { ...props.model.collection, visibleBooks: [...books] },
      externalSources: { ...props.model.externalSources, libraryWorks: externalWorks },
    },
    actions: {
      ...props.actions,
      books: {
        ...props.actions.books,
        open: (book) => {
          leave();
          return props.actions.books.open(book);
        },
        continueReading: (book) => {
          leave();
          return props.actions.books.continueReading(book);
        },
        openExternal: (id) => {
          leave();
          return props.actions.books.openExternal(id);
        },
        continueExternal: props.actions.books.continueExternal
          ? (id) => {
              leave();
              return props.actions.books.continueExternal!(id);
            }
          : undefined,
      },
    },
  });
  const recent = normalizeRecentSearches(data?.preferences.settings.recentSearches);
  const editRecent = (edit: (previous: string[]) => string[]) =>
    data?.preferences.updateSettings((previous) => ({
      ...previous,
      recentSearches: normalizeRecentSearches(edit(normalizeRecentSearches(previous.recentSearches))),
    }));
  return {
    library: (query) => searchLibrary(works, query),
    libraryHelpers,
    submitted: state.submitted,
    recent,
    removeRecent: (query) =>
      editRecent((previous) =>
        previous.filter(
          (entry) => entry.normalize('NFKC').toLowerCase() !== query.trim().normalize('NFKC').toLowerCase(),
        ),
      ),
    clearRecent: () => editRecent(() => []),
    submit: (value) => {
      const query = value.trim();
      if (query) editRecent((previous) => [query, ...previous]);
      store.submit(query);
    },
    cancel: store.cancel,
    sources: state.answers.map((answer) => ({
      sourceId: answer.id,
      title: answer.title,
      status: answer.status,
      error: answer.error,
      retry: () => store.retry(answer),
      openAll:
        state.submitted && data?.discovery
          ? () => {
              rememberDiscoverySourceDestination(
                data.discovery!.scope,
                {
                  id: answer.id,
                  sourceId: answer.source.id,
                  title: answer.title,
                  mode: 'popular',
                  parentRef: answer.parentRef,
                },
                state.submitted,
              );
              leave();
              setHomeActive(false);
              data.controller.setView('library');
              data.externalSources.close();
              data.discovery!.setActive(true);
            }
          : undefined,
      items: (answer.page?.items ?? []).map((item) => ({
        id: externalItemKeyId(item.key),
        title: item.title,
        author: item.author,
        thumbnailUrl: item.thumbnailUrl ?? (item.coverRef ? session?.peekCover(item.coverRef) : undefined),
        subline: item.subtitle,
        owned:
          data?.externalSources.libraryWorks.some(
            (work) =>
              !work.deletedAt &&
              work.connectorId === item.key.connectorId &&
              (work.accountConnectionId ?? '') === (item.key.accountConnectionId ?? '') &&
              (work.collectionRemoteId === item.key.remoteId || work.collectionRemoteId === item.navigationRef),
          ) ?? false,
        loadCover: item.coverRef && session ? (signal) => session.cover(item.coverRef!, signal) : undefined,
        open: () => {
          leave();
          setHomeActive(false);
          data?.controller.setView('library');
          return data?.externalSources.openDiscovery?.(
            answer.source.id as ExtensionContributionId,
            item.navigationRef
              ? { parentRef: item.navigationRef }
              : { parentRef: answer.parentRef, browseMode: 'search', query: state.submitted },
            item.navigationRef ? item.title : undefined,
          );
        },
      })),
    })),
  };
}
