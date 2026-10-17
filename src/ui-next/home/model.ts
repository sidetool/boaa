import type { HomeSourcePosition } from './source-continuity';
import type { HomeDiscoveryAdapter } from './discovery';
import type { ShelfMembership } from '../../domain/types';
import { bookFormatLabel } from '../../domain/book-format';
import { bookHeroLabels, relativeLastReadLabel, type HomeCurrentChapter } from './hero-labels';
import type { LibraryScreenProps, LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryBookView, LibraryFilter } from '../../features/library/library-screen-model';
import { orderedLibraryWorks, type LibraryWorkItem } from '../../features/library/library-work-order';
import { externalSelectionId } from '../../features/library/library-batch';
import { createUiNextLibraryAdapter } from '../library/model';
import type { UiNextNavigation } from '../shell/contract';
import type { HomeRowConfig, UiNextHomeAdapter, HomeHeroItem, HomeRowView } from './contract';
import { defaultHomeRows, resolveHomeRows, homeRowOptions, homeRowLabel, mergeHomeRowEdits } from './config';

export interface HomeAdapterInput {
  sourcePositions?: ReadonlyMap<string, HomeSourcePosition>;
  discoveryRows?: HomeDiscoveryAdapter;
  /** Required full catalog inputs: never pass the current library's visibleBooks/libraryWorks. */
  books: readonly LibraryBookView[];
  externalWorks: readonly (LibraryExternalWorkView & { description?: string })[];
  memberships: readonly Pick<ShelfMembership, 'bookId' | 'shelfId'>[];
  config?: readonly HomeRowConfig[];
  /** Already-loaded chapter metadata keyed by LibraryWorkItem.key; never triggers I/O. */
  currentChapters?: ReadonlyMap<string, HomeCurrentChapter>;
  now?: number;
  /** Downloaded books linked to external subscriptions with new releases. */
  updatedBookIds?: ReadonlySet<string>;
  setConfig(config: readonly HomeRowConfig[]): void;
  navigation: Pick<UiNextNavigation, 'openLibraryRoot' | 'openDiscovery'>;
}
const stamp = (value?: string) => {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
};
function lastRead(item: LibraryWorkItem, props: LibraryScreenProps): number {
  return item.kind === 'book'
    ? Math.max(
        stamp(item.book.novel.lastReadAt),
        stamp(props.model.externalSources.bookReadingActivity?.get(item.book.novel.id)?.lastReadAt),
      )
    : stamp(item.work.lastReadAt);
}
const unread = (item: LibraryWorkItem) =>
  item.kind === 'book' ? item.book.isUnread : !item.work.lastReadAt && !(item.work.readReleaseCount ?? 0);
const finished = (item: LibraryWorkItem, position?: HomeSourcePosition) =>
  item.kind === 'book'
    ? item.book.isFinished
    : item.work.availableReleaseCount > 0 &&
      (item.work.readReleaseCount ?? 0) >= item.work.availableReleaseCount &&
      (position?.progress === undefined || position.progress >= 1);

export function createUiNextHomeAdapter(props: LibraryScreenProps, input: HomeAdapterInput): UiNextHomeAdapter {
  const { model, actions } = props;
  const books = input.books.filter((book) => !book.novel.deletedAt);
  const externalWorks = input.externalWorks.filter((work) => !work.deletedAt);
  const library = createUiNextLibraryAdapter({
    ...props,
    model: {
      ...model,
      management: { ...model.management, selectionMode: false },
      collection: { ...model.collection, visibleBooks: [...books] },
      externalSources: { ...model.externalSources, libraryWorks: externalWorks },
    },
  });
  const added = orderedLibraryWorks(books, externalWorks, 'added');
  const discovery = input.discoveryRows?.sections ?? [];
  const config = resolveHomeRows(
    input.config,
    model.management.shelves,
    discovery,
    input.discoveryRows?.rowBuilder?.sources,
  );
  const read = added.filter((item) => !unread(item) || lastRead(item, props) > 0);
  const reason = read.length === 0 ? 'new' : 'continue';
  const candidates =
    reason === 'new'
      ? added.filter((item) => unread(item) && !finished(item, input.sourcePositions?.get(item.key))).slice(0, 3)
      : read
          .filter((item) => !finished(item, input.sourcePositions?.get(item.key)))
          .sort((a, b) => lastRead(b, props) - lastRead(a, props) || a.key.localeCompare(b.key))
          .slice(0, 5);
  const now = input.now ?? Date.now();
  const hero: HomeHeroItem[] = candidates.map((item) => {
    if (item.kind === 'book') {
      const { book } = item;
      return {
        item,
        reason,
        episodeNumber: book.sourcePosition?.episodeNumber,
        progress: library.bookProgress(book),
        ...bookHeroLabels(book, reason, input.currentChapters?.get(item.key)),
        lastReadLabel: reason === 'new' ? '' : relativeLastReadLabel(lastRead(item, props), now),
        tags: [bookFormatLabel(book.novel), ...(book.novel.tags ?? []).slice(0, 3)],
        synopsis: book.novel.description,
        resume: () => actions.books.continueReading(book.novel),
        openDetail: () => actions.books.open(book.novel),
      };
    }
    const { work } = item;
    const chapter = input.currentChapters?.get(item.key);
    return {
      item,
      reason,
      progress: library.externalProgress(work),
      sourcePosition: input.sourcePositions?.get(item.key),
      positionLabel: chapter
        ? chapter.title?.trim()
          ? `${chapter.index}화 · ${chapter.title.trim()}`
          : `${chapter.index}화 / ${work.availableReleaseCount}화`
        : `${work.readReleaseCount ?? 0}화 / ${work.availableReleaseCount}화`,
      lastReadLabel: reason === 'new' ? '' : relativeLastReadLabel(lastRead(item, props), now),
      resumeLabel: reason === 'new' ? '첫 화 보기' : chapter ? `${chapter.index}화 이어 보기` : '이어 보기',
      synopsis: input.externalWorks.find((candidate) => candidate.id === work.id)?.description,
      tags: work.sourceLabel ? [work.sourceLabel] : [],
      resume: () => (actions.books.continueExternal ?? actions.books.openExternal)(work.id),
      openDetail: () => actions.books.openExternal(work.id),
    };
  });
  const openLibrary = (filter: LibraryFilter, shelfId?: string) => {
    input.navigation.openLibraryRoot();
    actions.header.setQuery('');
    actions.controls.setFilter(filter);
    actions.controls.setShelf(shelfId);
  };
  const rows: HomeRowView[] = config
    .filter((row) => row.visible)
    .map((row) => {
      if (row.kind === 'discovery' || row.kind === 'source') return input.discoveryRows!.row(row);
      const ids = new Set(
        input.memberships.filter((member) => member.shelfId === row.shelfId).map((member) => member.bookId),
      );
      const items = added
        .filter((item) => {
          switch (row.kind) {
            case 'unread':
              return unread(item);
            case 'finished':
              return finished(item, input.sourcePositions?.get(item.key));
            case 'favorites':
              return item.kind === 'book' && item.book.novel.favorite;
            case 'shelf':
              return ids.has(item.kind === 'book' ? item.book.novel.id : externalSelectionId(item.work.id));
            case 'external-updates':
              return item.kind === 'external'
                ? item.work.newReleaseCount > 0
                : input.updatedBookIds?.has(item.book.novel.id) === true;
            default:
              return true;
          }
        })
        .slice(0, 20)
        .map((item) => ({ kind: 'library' as const, key: item.key, item }));
      const filter =
        row.kind === 'favorites'
          ? 'favorite'
          : row.kind === 'unread'
            ? 'unread'
            : row.kind === 'finished'
              ? 'finished'
              : 'all';
      return {
        config: row,
        title: homeRowLabel(row, model.management.shelves, discovery),
        status:
          row.kind === 'external-updates'
            ? (model.externalSources.libraryBootstrap?.status ?? model.bootstrap.status)
            : model.bootstrap.status,
        items,
        // No existing library filter expresses "external works with updates". Avoid an inaccurate all-items destination.
        openAll: row.kind === 'external-updates' ? undefined : () => openLibrary(filter, row.shelfId),
      };
    });
  return {
    status: model.bootstrap.status,
    hero,
    rows,
    config,
    rowBuilder: input.discoveryRows?.rowBuilder,
    rowOptions: homeRowOptions(config, model.management.shelves, discovery),
    rowLabel: (row) => homeRowLabel(row, model.management.shelves, discovery),
    setConfig: (next) => input.setConfig(mergeHomeRowEdits(input.config, config, next)),
    resetConfig: () => input.setConfig(defaultHomeRows()),
    library,
    importFiles: actions.header.openImport,
    addSamples: () => {
      void actions.books.addSample();
    },
    openDiscovery: input.navigation.openDiscovery,
  };
}
