import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import {
  filterStorageBooks,
  useStorageBookManagerModel,
  type StorageBookManagerModel,
  type StorageBookManagerModelInput,
} from './use-storage-book-manager-model';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
const books = [
  { id: 'b', title: 'Beta', bytes: 20, metadataRevision: 2, trashed: false },
  { id: 'a', title: 'Alpha', bytes: 10, metadataRevision: 3, trashed: false },
  { id: 'c', title: 'Gamma', bytes: 30, metadataRevision: 4, trashed: true },
];
function setup(confirm: StorageBookManagerModelInput['confirm'] = () => true) {
  const catalog = { moveToTrash: vi.fn(async () => {}), restore: vi.fn(async () => {}), purge: vi.fn(async () => {}) };
  const onChanged = vi.fn(async () => {}),
    refresh = vi.fn(async () => {}),
    onBusyChange = vi.fn();
  let input: StorageBookManagerModelInput = {
    usage: { books, totalBytes: 60, libraryBytes: 30, trashBytes: 30 },
    management: { catalog: catalog as unknown as LibraryCatalogRepository, blocked: false, onChanged },
    refresh,
    confirm,
    onBusyChange,
  };
  let model!: StorageBookManagerModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useStorageBookManagerModel(input);
    return null;
  }
  act(() => {
    renderer = create(createElement(Harness));
  });
  return {
    get model() {
      return model;
    },
    catalog,
    onChanged,
    refresh,
    onBusyChange,
    update: (patch: Partial<StorageBookManagerModelInput>) => {
      input = { ...input, ...patch };
      act(() => renderer.update(createElement(Harness)));
    },
    close: () => act(() => renderer.unmount()),
  };
}
it('filters and sorts without mutating the input', () => {
  expect(filterStorageBooks(books, false, ' A ', 'name').map((book) => book.id)).toEqual(['a', 'b']);
  expect(filterStorageBooks(books, true, '', 'size').map((book) => book.id)).toEqual(['c']);
  expect(books.map((book) => book.id)).toEqual(['b', 'a', 'c']);
});
it('resets selection and pagination when searching or switching locations', () => {
  const h = setup();
  act(() => {
    h.model.loadMore();
    h.model.select('a', true);
  });
  expect(h.model.limit).toBe(100);
  expect(h.model.selectedBytes).toBe(10);
  act(() => h.model.changeQuery('Alpha'));
  expect(h.model.limit).toBe(50);
  expect(h.model.selected.size).toBe(0);
  act(() => h.model.changeLocation(true));
  expect(h.model.trash).toBe(true);
  expect(h.model.query).toBe('Alpha');
  h.close();
});
it('reports partial success, keeps revision checks and distinguishes a refresh failure', async () => {
  const confirm = vi.fn(() => true);
  const h = setup(confirm);
  h.catalog.moveToTrash.mockRejectedValueOnce(new Error('revision'));
  h.refresh.mockRejectedValueOnce(new Error('offline'));
  act(() => {
    h.model.select('a', true);
    h.model.select('b', true);
  });
  await act(async () => {
    expect(await h.model.mutate('moveToTrash')).toEqual({
      action: 'moveToTrash',
      completed: 1,
      remaining: 1,
      refreshFailed: true,
    });
  });
  expect(confirm).toHaveBeenCalledWith({ action: 'moveToTrash', count: 2, titles: ['Beta', 'Alpha'] });
  expect(h.catalog.moveToTrash.mock.calls).toEqual([
    ['b', 2],
    ['a', 3],
  ]);
  expect(h.model.selected.size).toBe(0);
  expect(h.model.busy).toBe(false);
  expect(h.onBusyChange.mock.calls).toEqual([[true], [false]]);
  h.close();
});
it('serializes async confirmation and rechecks blocking before mutating', async () => {
  let answer!: (value: boolean) => void;
  const confirm = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const h = setup(confirm);
  act(() => h.model.select('a', true));
  const pending = h.model.mutate('moveToTrash');
  expect(await h.model.mutate('moveToTrash')).toBeUndefined();
  expect(confirm).toHaveBeenCalledOnce();
  h.update({
    management: { blocked: true, catalog: h.catalog as unknown as LibraryCatalogRepository, onChanged: h.onChanged },
  });
  await act(async () => {
    answer(true);
    expect(await pending).toBeUndefined();
  });
  expect(h.catalog.moveToTrash).not.toHaveBeenCalled();
  expect(h.onBusyChange).not.toHaveBeenCalled();
  h.close();
});
it('releases the confirmation lock after cancellation or rejection', async () => {
  const confirm = vi
    .fn<StorageBookManagerModelInput['confirm']>()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('dismissed'))
    .mockResolvedValueOnce(true);
  const h = setup(confirm);
  act(() => h.model.select('a', true));
  expect(await h.model.mutate('moveToTrash')).toBeUndefined();
  await expect(h.model.mutate('moveToTrash')).rejects.toThrow('dismissed');
  await act(async () => {
    await h.model.mutate('moveToTrash');
  });
  expect(h.catalog.moveToTrash).toHaveBeenCalledOnce();
  h.close();
});
