import { describe, expect, it, vi } from 'vitest';
import { actions, model, novel } from '../test-fixtures';
import { createUiNextLibraryAdapter, bookProgress, externalProgress } from './model';
import type { LibraryAction } from './contract';
import type { LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { ImportTaskView } from '../../features/import/import-task-projection';

const remote: LibraryExternalWorkView = {
  id: 'remote-1',
  title: '원격 작품',
  availableReleaseCount: 10,
  readReleaseCount: 3,
  newReleaseCount: 0,
  addedAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const task: ImportTaskView = {
  id: 'task-1',
  batchId: 'batch-1',
  title: '가져올 작품',
  source: 'local_file',
  phase: 'preparing',
};
const run = (items: readonly LibraryAction[], id: string) => items.find((item) => item.id === id)!.run();
function fixture() {
  const props = { model: model([novel()]), actions: actions() };
  return { props, adapter: () => createUiNextLibraryAdapter(props), book: props.model.collection.visibleBooks[0] };
}
describe('library adapter', () => {
  it('uses authoritative counts without recounting filtered remote works and preserves combined ordering', () => {
    const { props, adapter } = fixture();
    props.model.externalSources.libraryWorks = [remote];
    props.model.collection.filterCounts.all = 12;
    props.model.sort = 'added';
    expect(adapter().filterCounts).toBe(props.model.collection.filterCounts);
    expect(adapter().works.map((item) => item.kind)).toEqual(['book', 'external']);
  });
  it('calculates bounded progress and sublines for local, volume and streamed books', () => {
    const { book } = fixture();
    expect(bookProgress(book)).toEqual({ progress: 0, percent: 0, subline: '새 작품' });
    expect(
      bookProgress({ ...book, bookProgress: 0.2, readingCounts: { current: 37, total: 214, unit: '화' } }).subline,
    ).toBe('37화 · 177화 남음');
    expect(
      bookProgress({ ...book, bookProgress: 0.2, readingCounts: { current: 2, total: 4, unit: '권' } }).subline,
    ).toBe('2권 읽는 중');
    expect(bookProgress({ ...book, bookProgress: 2 }).percent).toBe(100);
    expect(bookProgress({ ...book, bookProgress: NaN }).percent).toBe(0);
    expect(externalProgress(remote)).toEqual({ progress: 0.3, percent: 30, subline: '3화 · 7화 남음' });
    expect(externalProgress({ ...remote, availableReleaseCount: 0 }).percent).toBe(0);
  });
  it('routes all local menu actions and honors download/import/busy guards', () => {
    const { props, adapter, book } = fixture();
    Object.assign(props.actions.books, {
      rename: vi.fn(),
      moveToShelf: vi.fn(),
      downloadFromMenu: vi.fn(),
      canDownloadFromMenu: () => true,
    });
    const menu = adapter().bookMenu(book);
    expect(menu.map((item) => item.id)).toEqual([
      'continue',
      'open',
      'favorite',
      'move',
      'rename',
      'metadata',
      'download',
      'remove',
    ]);
    menu.forEach((item) => item.run());
    for (const key of [
      'continueReading',
      'open',
      'toggleFavorite',
      'moveToShelf',
      'rename',
      'editMetadata',
      'downloadFromMenu',
      'remove',
    ] as const)
      expect(props.actions.books[key]).toHaveBeenCalledWith(book.novel);
    props.model.importTasks = [{ ...task, targetBookId: book.novel.id }];
    const blocked = adapter()
      .bookMenu(book)
      .find((item) => item.id === 'remove')!;
    expect(blocked.disabled).toBe(true);
    blocked.run();
    expect(props.actions.books.remove).toHaveBeenCalledTimes(1);
    props.actions.books.canDownloadFromMenu = () => false;
    expect(
      adapter()
        .bookMenu(book)
        .find((item) => item.id === 'download')?.disabled,
    ).toBe(true);
    book.novel.deletedAt = '2026-01-01';
    props.model.importTasks = [];
    const trash = adapter().bookMenu(book);
    expect(trash.map((item) => item.id)).toEqual(['restore', 'purge']);
    trash.forEach((item) => item.run());
    expect(props.actions.books.restore).toHaveBeenCalledWith(book.novel);
    expect(props.actions.books.purge).toHaveBeenCalledWith(book.novel);
  });
  it('retains optional external capabilities and trash operations', () => {
    const { props, adapter } = fixture();
    expect(
      adapter()
        .externalMenu(remote)
        .map((item) => item.id),
    ).toEqual(['open', 'remove']);
    Object.assign(props.actions.books, {
      continueExternal: vi.fn(),
      renameExternal: vi.fn(),
      moveExternalToShelf: vi.fn(),
      downloadExternal: vi.fn(),
      restoreExternal: vi.fn(),
      purgeExternal: vi.fn(),
    });
    adapter()
      .externalMenu(remote)
      .forEach((item) => item.run());
    for (const key of [
      'continueExternal',
      'openExternal',
      'renameExternal',
      'moveExternalToShelf',
      'downloadExternal',
      'removeExternal',
    ] as const)
      expect(props.actions.books[key]).toHaveBeenCalledWith(remote.id);
    adapter()
      .externalMenu({ ...remote, deletedAt: '2026-01-01' })
      .forEach((item) => item.run());
    expect(props.actions.books.restoreExternal).toHaveBeenCalledWith(remote.id);
    expect(props.actions.books.purgeExternal).toHaveBeenCalledWith(remote.id);
  });
  it('separates bound, completed and standalone imports with query/shelf/filter/selection rules', () => {
    const { props, adapter, book } = fixture();
    props.model.importTasks = [
      task,
      { ...task, id: 'bound', targetBookId: book.novel.id },
      { ...task, id: 'complete', phase: 'complete' },
    ];
    expect(adapter().standaloneImportTasks.map((item) => item.id)).toEqual([task.id]);
    expect(adapter().taskForBook(book.novel.id)?.id).toBe('bound');
    props.model.query = 'unmatched';
    expect(adapter().standaloneImportTasks).toEqual([]);
    props.model.query = '';
    props.model.management.activeShelfId = 'shelf';
    expect(adapter().standaloneImportTasks).toEqual([]);
    props.model.management.activeShelfId = undefined;
    props.model.management.selectionMode = true;
    expect(adapter().standaloneImportTasks).toEqual([]);
    expect(
      adapter()
        .importActions(task)
        .map((item) => item.id),
    ).toEqual(['open']);
    const failed = { ...task, phase: 'failed' as const };
    adapter()
      .importActions(failed)
      .forEach((item) => item.run());
    expect(props.actions.imports.open).toHaveBeenCalledWith(failed);
    expect(props.actions.imports.dismiss).toHaveBeenCalledWith(task.id);
  });
  it('opens or selects works with external ids and never opens trash or selects active imports', () => {
    const { props, adapter, book } = fixture();
    props.model.externalSources.libraryWorks = [remote];
    props.actions.books.toggleSelectedExternal = vi.fn();
    adapter().works.forEach((item) => adapter().activate(item));
    expect(props.actions.books.open).toHaveBeenCalledWith(book.novel);
    expect(props.actions.books.openExternal).toHaveBeenCalledWith(remote.id);
    props.model.management.selectionMode = true;
    props.model.management.selectedBookIds = new Set(['external:remote-1']);
    const next = adapter();
    expect(next.isSelected(next.works.find((item) => item.kind === 'external')!)).toBe(true);
    next.works.forEach((item) => next.activate(item));
    expect(props.actions.books.toggleSelectedExternal).toHaveBeenCalledWith(remote.id);
    props.model.importTasks = [{ ...task, targetBookId: book.novel.id }];
    adapter().activate(next.works.find((item) => item.kind === 'book')!);
    expect(props.actions.books.toggleSelected).toHaveBeenCalledTimes(1);
    props.model.management.selectionMode = false;
    book.novel.deletedAt = '2026-01-01';
    adapter().activate(next.works.find((item) => item.kind === 'book')!);
    expect(props.actions.books.open).toHaveBeenCalledTimes(1);
  });
  it('routes import, sorting and management commands without UI state', () => {
    const { props, adapter } = fixture();
    props.actions.header.openDiscovery = vi.fn();
    adapter().importMenu.forEach((item) => item.run());
    expect(props.actions.header.openImport).toHaveBeenCalled();
    expect(props.actions.header.openLibraryFolders).toHaveBeenCalled();
    expect(props.actions.header.openDiscovery).toHaveBeenCalled();
    adapter().sortActions.forEach((item) => item.run());
    expect(props.actions.controls.setSort).toHaveBeenNthCalledWith(1, 'recent');
    expect(props.actions.controls.setSort).toHaveBeenNthCalledWith(2, 'added');
    expect(props.actions.controls.setSort).toHaveBeenNthCalledWith(3, 'title');
    expect(adapter().sortActions.find((item) => item.selected)?.id).toBe('recent');
    adapter().managementActions.forEach((item) => item.run());
    expect(props.actions.controls.startSelection).toHaveBeenCalled();
    expect(props.actions.controls.openShelves).toHaveBeenCalled();
    expect(props.actions.controls.setFilter).toHaveBeenCalledWith('trash');
    expect(props.actions.header.openSync).toHaveBeenCalled();
    expect(props.actions.header.openBackup).toHaveBeenCalled();
    props.model.filter = 'trash';
    props.model.collection.filterCounts.trash = 1;
    run(adapter().managementActions, 'empty_trash');
    expect(props.actions.controls.emptyTrash).toHaveBeenCalled();
  });
});
