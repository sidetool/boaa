import type { LibraryScreenProps, LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryBookView } from '../../features/library/library-screen-model';
import { orderedLibraryWorks } from '../../features/library/library-work-order';
import { externalSelectionId } from '../../features/library/library-batch';
import { importTaskIsActive } from '../../features/import/import-task-projection';
import type { LibraryProgress, UiNextLibraryAdapter } from './contract';
import { batchLibraryActions, bookMenuActions, externalMenuActions, libraryAction } from './actions';

function progressSummary(value: number, current: number, total: number, unit: string): LibraryProgress {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const remaining = Math.max(0, total - current);
  const subline =
    current <= 0 && progress === 0
      ? '새 작품'
      : progress >= 1
        ? '완독'
        : unit === '권'
          ? `${current}권 읽는 중`
          : current > 0
            ? `${current}${unit}${remaining > 0 ? ` · ${remaining}${unit} 남음` : ''}`
            : '읽는 중';
  return { progress, percent: Math.round(progress * 100), subline };
}
export function bookProgress(book: LibraryBookView): LibraryProgress {
  const counts = book.readingCounts;
  return {
    ...progressSummary(book.bookProgress, counts?.current ?? 0, counts?.total ?? 0, counts?.unit ?? '화'),
    ...(book.sourcePosition
      ? { episodeNumber: book.sourcePosition.episodeNumber, current: counts?.current, total: counts?.total }
      : {}),
  };
}
export function externalProgress(work: LibraryExternalWorkView): LibraryProgress {
  const current = work.readReleaseCount ?? 0;
  return progressSummary(
    work.availableReleaseCount > 0 ? current / work.availableReleaseCount : 0,
    current,
    work.availableReleaseCount,
    '화',
  );
}

/** Pure adapter: retains the controller's filtering/count semantics and command ownership. */
export function createUiNextLibraryAdapter(props: LibraryScreenProps): UiNextLibraryAdapter {
  const { model, actions } = props;
  const works = orderedLibraryWorks(
    model.collection.visibleBooks,
    model.externalSources.libraryWorks ?? [],
    model.sort,
    model.externalSources.bookReadingActivity,
  );
  const tasks = model.importTasks.filter((task) => task.phase !== 'complete');
  const taskForBook = (id: string) => tasks.find((task) => task.targetBookId === id);
  const taskForExternal = (id: string) => tasks.find((task) => task.externalWorkId === id);
  const bookIds = new Set(model.collection.visibleBooks.map((book) => book.novel.id));
  const externalIds = new Set(model.externalSources.libraryWorks?.map((work) => work.id));
  const query = model.query.trim().toLocaleLowerCase();
  const standaloneImportTasks =
    !model.management.selectionMode && model.filter === 'all' && !model.management.activeShelfId
      ? tasks.filter(
          (task) =>
            !(task.targetBookId && bookIds.has(task.targetBookId)) &&
            !(task.externalWorkId && externalIds.has(task.externalWorkId)) &&
            (!query || [task.title, task.fileName].some((value) => value?.toLocaleLowerCase().includes(query))),
        )
      : [];
  return {
    works,
    standaloneImportTasks,
    taskForBook,
    taskForExternal,
    filterCounts: model.collection.filterCounts,
    bookProgress,
    externalProgress,
    bookMenu: (book) => bookMenuActions(props, book),
    externalMenu: (work) => externalMenuActions(props, work),
    batchActions: (input) => batchLibraryActions(props, input),
    importActions: (task) => [
      libraryAction('open', '가져오기 상태 열기', () => actions.imports.open(task)),
      ...(!importTaskIsActive(task)
        ? [
            libraryAction('retry', '다시 시도', () => actions.imports.open(task)),
            libraryAction('dismiss', '닫기', () => actions.imports.dismiss(task.id)),
          ]
        : []),
    ],
    importMenu: [
      libraryAction('file', '파일 가져오기', actions.header.openImport),
      libraryAction('folder', '폴더 연결', actions.header.openLibraryFolders),
      ...(actions.header.openDiscovery
        ? [libraryAction('discovery', '소스에서 찾기', actions.header.openDiscovery)]
        : []),
    ],
    sortActions: (
      [
        ['recent', '최근 읽은 순'],
        ['added', '최근 추가한 순'],
        ['title', '제목순'],
      ] as const
    ).map(([sort, label]) => ({
      ...libraryAction(sort, label, () => actions.controls.setSort(sort)),
      selected: model.sort === sort,
    })),
    managementActions: [
      ...(model.management.available
        ? [
            libraryAction('select', '여러 개 선택', actions.controls.startSelection, model.management.busy),
            libraryAction('shelves', '책장 관리', actions.controls.openShelves, model.management.busy),
          ]
        : []),
      libraryAction('trash', '휴지통', () => actions.controls.setFilter('trash')),
      ...(model.filter === 'trash'
        ? [
            libraryAction(
              'empty_trash',
              '휴지통 비우기',
              actions.controls.emptyTrash,
              model.management.busy || model.collection.filterCounts.trash === 0,
              true,
            ),
          ]
        : []),
      // TODO: Phase 6 moves synchronization and backup into settings.
      libraryAction('sync', '동기화 열기', actions.header.openSync),
      libraryAction('backup', '백업과 복원', actions.header.openBackup),
    ],
    isSelected: (item) =>
      model.management.selectedBookIds.has(
        item.kind === 'book' ? item.book.novel.id : externalSelectionId(item.work.id),
      ),
    pick: model.management.available
      ? (item) => {
          if (model.management.busy) return;
          actions.controls.startSelection();
          if (item.kind === 'book') actions.books.toggleSelected(item.book.novel);
          else actions.books.toggleSelectedExternal?.(item.work.id);
        }
      : undefined,
    activate: (item) => {
      const task = item.kind === 'book' ? taskForBook(item.book.novel.id) : taskForExternal(item.work.id);
      if (model.management.selectionMode) {
        if (model.management.busy || (task && importTaskIsActive(task))) return;
        return item.kind === 'book'
          ? actions.books.toggleSelected(item.book.novel)
          : actions.books.toggleSelectedExternal?.(item.work.id);
      }
      if (item.kind === 'book') {
        if (!item.book.novel.deletedAt) return actions.books.open(item.book.novel);
      } else if (!item.work.deletedAt) return actions.books.openExternal(item.work.id);
    },
  };
}
