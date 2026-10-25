import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryFolderLocalStateStore, resetLibraryFolderLocalStateForTests } from '../../library-folders/local-state';
import { ImportCommittedRefreshError } from '../../services/import/import-service';
import {
  DEFAULT_LIBRARY_FOLDER_FILTER,
  type LibraryFolderSourceEntry,
  type LinkedLibraryFolder,
  type StoredLibraryFolderEntry,
} from '../../library-folders/contracts';
import { enrichScannedLibraryFolderEntries, useLibraryFolderController } from './useLibraryFolderController';

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetLibraryFolderLocalStateForTests();
});

const folder: LinkedLibraryFolder = {
  id: 'folder-1',
  providerKind: 'android-saf',
  displayName: 'Books',
  filter: DEFAULT_LIBRARY_FOLDER_FILTER,
  autoSync: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function source(overrides: Partial<LibraryFolderSourceEntry> = {}): LibraryFolderSourceEntry {
  return {
    sourceKey: 'document-1',
    relativePath: 'book.txt',
    fileName: 'book.txt',
    byteLength: 3,
    lastModified: 0,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredLibraryFolderEntry> = {}): StoredLibraryFolderEntry {
  return {
    ...source(),
    id: 'folder-1::document-1',
    folderId: folder.id,
    signature: 'document-1\u00003\u00000',
    bookId: 'book-1',
    contentHash: 'sha256:old-source',
    status: 'linked',
    firstSeenAt: folder.createdAt,
    lastSeenAt: folder.createdAt,
    ...overrides,
  };
}

describe('enrichScannedLibraryFolderEntries', () => {
  it('keeps the canonical folder binding after a committed import so another scan does not reupload', async () => {
    vi.stubGlobal('window', {
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const state = new LibraryFolderLocalStateStore('committed-folder-test');
    await state.saveFolder({ ...folder, autoSync: false });
    const retry = vi.fn(async () => {
      throw new Error('offline');
    });
    const acknowledge = vi.fn();
    const importFile = vi.fn(() => ({
      jobId: 'job',
      cancel: vi.fn(),
      promise: Promise.reject(new ImportCommittedRefreshError('canonical-book', retry, acknowledge)),
    }));
    const notify = vi.fn();
    let controller!: ReturnType<typeof useLibraryFolderController>;
    function Harness() {
      controller = useLibraryFolderController({
        state,
        notify,
        importService: { importFile },
        listNovels: async () => [],
        getNovel: async () => undefined,
        onLibraryChanged: async () => {},
        io: {
          available: true,
          providerKind: 'android-saf',
          pickFolder: async () => undefined,
          scanFolder: async () => [source()],
          readFile: async () => new File(['new'], 'book.txt', { lastModified: 0 }),
          forgetFolder: async () => {},
        },
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      await controller.selectFolder(folder.id);
    });
    await act(async () => {
      await controller.importSelected();
    });
    expect((await state.listEntries(folder.id))[0]).toMatchObject({ bookId: 'canonical-book', status: 'linked' });
    expect(controller.progress).toMatchObject({ completed: 1, failed: 0 });
    expect(controller.candidates[0]).toMatchObject({ status: 'unchanged', selected: false });
    await act(async () => {
      await controller.importSelected();
    });
    expect(importFile).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('목록 새로고침이 필요합니다'), 'warning');
    await act(async () => renderer.unmount());
  });
  it('hashes an existing same-metadata Android entry even when mtime is zero', async () => {
    const readFile = vi.fn(async () => new File(['new'], 'book.txt', { lastModified: 0 }));

    const [result] = await enrichScannedLibraryFolderEntries({
      folder,
      sourceEntries: [source()],
      storedEntries: [stored()],
      io: { readFile },
    });

    expect(readFile).toHaveBeenCalledOnce();
    expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.contentHash).not.toBe('sha256:old-source');
  });

  it('hashes only plausible rename candidates and skips unrelated new files', async () => {
    const renamed = source({ sourceKey: 'document-renamed', relativePath: 'renamed.txt', fileName: 'renamed.txt' });
    const unrelated = source({
      sourceKey: 'document-new',
      relativePath: 'unrelated.epub',
      fileName: 'unrelated.epub',
    });
    const readFile = vi.fn(
      async (_folder: LinkedLibraryFolder, entry: LibraryFolderSourceEntry) =>
        new File(['new'], entry.fileName, { lastModified: entry.lastModified }),
    );

    const results = await enrichScannedLibraryFolderEntries({
      folder,
      sourceEntries: [renamed, unrelated],
      storedEntries: [stored()],
      io: { readFile },
    });

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(folder, renamed);
    expect(results[0].contentHash).toMatch(/^sha256:/);
    expect(results[1].contentHash).toBeUndefined();
  });

  it('keeps scanning other entries when one fingerprint read fails', async () => {
    const secondSource = source({ sourceKey: 'document-2', relativePath: 'second.txt', fileName: 'second.txt' });
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission revoked'))
      .mockResolvedValueOnce(new File(['two'], 'second.txt', { lastModified: 0 }));

    const results = await enrichScannedLibraryFolderEntries({
      folder,
      sourceEntries: [source(), secondSource],
      storedEntries: [stored(), stored({ id: 'folder-1::document-2', sourceKey: 'document-2' })],
      io: { readFile },
    });

    expect(results[0]).toMatchObject({ readError: 'permission revoked' });
    expect(results[0].contentHash).toBeUndefined();
    expect(results[1]).toMatchObject({ readError: undefined });
    expect(results[1].contentHash).toMatch(/^sha256:/);
  });
});
