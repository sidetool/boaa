import { expect, it, vi } from 'vitest';
import type { BookAssetMetadata } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { testNovel, testWorkspaceState } from '../book-workspace/book-workspace-test-fixtures';
import { LibrarySourceFilesController, type LibrarySourceFilesPorts } from './library-source-files-controller';

const portable = vi.hoisted(() => vi.fn());
vi.mock('../../repositories/comic-source-export', () => ({ exportPortableBookSource: portable }));
const metadata: BookAssetMetadata = {
  id: 'asset',
  bookId: 'book',
  kind: 'source',
  provenance: 'original',
  status: 'active',
  storageKey: 'asset',
  contentType: 'text/plain',
  byteLength: 4,
  contentHash: 'hash',
  createdAt: '2026-01-01',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(browser = false) {
  const novel = testNovel();
  let state = testWorkspaceState({ selectedNovel: novel, view: 'chapters' });
  const listeners = new Set<() => void>();
  const assets: BookAssetRepository = {
    getActiveSource: vi.fn(),
    exportSource: vi.fn(),
    openSource: vi.fn(),
    reselectOriginalSource: vi.fn(async () => metadata),
    reconstructCanonicalSource: vi.fn(async () => metadata),
    getActiveCover: vi.fn(),
    saveCover: vi.fn(),
    removeCover: vi.fn(),
    getEmbeddedResource: vi.fn(),
    listOriginalFiles: vi.fn(async () => []),
    createOriginalFileDownload: vi.fn(async () => '/download'),
  };
  const ports: LibrarySourceFilesPorts = {
    assets,
    browser,
    reader: { getNovel: vi.fn(async () => novel) },
    workspace: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      openNovel: vi.fn(async () => undefined),
    },
    documentIo: { saveDocument: vi.fn(async () => 'saved' as const) },
    refresh: vi.fn(async () => undefined),
    notify: vi.fn(),
  };
  let owner = true;
  const controller = new LibrarySourceFilesController(ports, () => owner);
  return {
    controller,
    ports,
    assets,
    novel,
    listeners,
    replaceOwner: () => {
      owner = false;
    },
    navigate: (id: string) => {
      state = { ...state, selectedNovel: { ...novel, id } };
      listeners.forEach((listener) => listener());
    },
  };
}

it('keeps browser originals in a subscribed dialog and exports the selected legacy fallback', async () => {
  const h = harness(true);
  const listener = vi.fn();
  h.controller.subscribe(listener);
  portable.mockResolvedValueOnce({ metadata, blob: new Blob(['text']) });
  h.controller.exportSource(h.novel);
  expect(h.controller.getSnapshot()).toBe(h.novel);
  await h.controller.exportDialogLegacy();
  expect(h.controller.getSnapshot()).toBeUndefined();
  expect(h.ports.documentIo.saveDocument).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledTimes(2);
});
it('finishes an accepted export after book navigation without reopening the book', async () => {
  const h = harness();
  const source = deferred<{ metadata: BookAssetMetadata; blob: Blob }>();
  portable.mockReturnValueOnce(source.promise);
  const pending = h.controller.exportLegacy(h.novel);
  await vi.waitFor(() => expect(portable).toHaveBeenLastCalledWith(h.assets, h.novel.id));
  h.navigate('other');
  source.resolve({ metadata, blob: new Blob(['text']) });
  await pending;
  expect(h.ports.documentIo.saveDocument).toHaveBeenCalledOnce();
  expect(h.ports.workspace.openNovel).not.toHaveBeenCalled();
});
it('blocks a save dialog when the session owner changes during portable export', async () => {
  const h = harness();
  const source = deferred<{ metadata: BookAssetMetadata; blob: Blob }>();
  portable.mockReturnValueOnce(source.promise);
  const pending = h.controller.exportLegacy(h.novel);
  await vi.waitFor(() => expect(portable).toHaveBeenLastCalledWith(h.assets, h.novel.id));
  h.replaceOwner();
  source.resolve({ metadata, blob: new Blob() });
  await pending;
  expect(h.ports.documentIo.saveDocument).not.toHaveBeenCalled();
  expect(h.ports.notify).not.toHaveBeenCalled();
});
it('refreshes a persisted reconstruction but never reopens after navigation ABA', async () => {
  const h = harness();
  const source = deferred<BookAssetMetadata>();
  vi.mocked(h.assets.reconstructCanonicalSource!).mockReturnValueOnce(source.promise);
  const pending = h.controller.reconstructSource(h.novel);
  h.navigate('other');
  h.navigate(h.novel.id);
  source.resolve(metadata);
  await pending;
  expect(h.ports.refresh).toHaveBeenCalledOnce();
  expect(h.ports.workspace.openNovel).not.toHaveBeenCalled();
  expect(h.ports.notify).toHaveBeenCalledWith(expect.any(String), 'success');
  expect(h.listeners.size).toBe(0);
});
it('reopens the refreshed book after reselect when navigation is unchanged', async () => {
  const h = harness();
  await h.controller.reselectSource(h.novel, new File(['text'], 'source.txt'));
  expect(h.assets.reselectOriginalSource).toHaveBeenCalledWith(
    h.novel.id,
    expect.objectContaining({ contentType: 'text/plain' }),
  );
  expect(h.ports.workspace.openNovel).toHaveBeenCalledWith(h.novel);
});
it('does not refresh, reopen, or notify from an old operation after cleanup and reactivation', async () => {
  const h = harness();
  const source = deferred<BookAssetMetadata>();
  vi.mocked(h.assets.reconstructCanonicalSource!).mockReturnValueOnce(source.promise);
  const pending = h.controller.reconstructSource(h.novel);
  h.controller.deactivate();
  h.controller.activate();
  source.resolve(metadata);
  await pending;
  expect(h.ports.refresh).not.toHaveBeenCalled();
  expect(h.ports.notify).not.toHaveBeenCalled();
  expect(h.listeners.size).toBe(0);
  await h.controller.reconstructSource(h.novel);
  expect(h.ports.refresh).toHaveBeenCalledOnce();
});
it('blocks late errors after owner replacement', async () => {
  const h = harness();
  let reject!: (reason: Error) => void;
  vi.mocked(h.assets.reconstructCanonicalSource!).mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const pending = h.controller.reconstructSource(h.novel);
  h.replaceOwner();
  reject(new Error('old error'));
  await pending;
  expect(h.ports.notify).not.toHaveBeenCalled();
});

it('reads persisted book metadata for each completion when two accepted mutations finish in reverse order', async () => {
  const h = harness();
  const first = deferred<BookAssetMetadata>();
  const second = deferred<BookAssetMetadata>();
  vi.mocked(h.assets.reconstructCanonicalSource!)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const older = h.controller.reconstructSource(h.novel);
  const newer = h.controller.reconstructSource(h.novel);
  const secondBook = { ...h.novel, sourceFileName: 'second.txt' };
  vi.mocked(h.ports.reader.getNovel).mockResolvedValueOnce(secondBook);
  second.resolve(metadata);
  await newer;
  const firstBook = { ...h.novel, sourceFileName: 'first.txt' };
  vi.mocked(h.ports.reader.getNovel).mockResolvedValueOnce(firstBook);
  first.resolve(metadata);
  await older;
  expect(h.ports.workspace.openNovel).toHaveBeenNthCalledWith(1, secondBook);
  expect(h.ports.workspace.openNovel).toHaveBeenNthCalledWith(2, firstBook);
  expect(h.listeners.size).toBe(0);
});

it('does not reopen when navigation changes while refreshed metadata is being read', async () => {
  const h = harness();
  const book = deferred<ReturnType<typeof testNovel> | undefined>();
  vi.mocked(h.ports.reader.getNovel).mockReturnValueOnce(book.promise);
  const pending = h.controller.reconstructSource(h.novel);
  await vi.waitFor(() => expect(h.ports.reader.getNovel).toHaveBeenCalledOnce());
  h.navigate('other');
  book.resolve(h.novel);
  await pending;
  expect(h.ports.workspace.openNovel).not.toHaveBeenCalled();
});
