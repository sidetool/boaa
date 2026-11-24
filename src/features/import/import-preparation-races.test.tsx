import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@boaa/text-core/hash';
import type { Chapter, Novel } from '../../domain/types';
import { ImportCommittedRefreshError, type ImportService } from '../../services/import/import-service';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import { useImportUploadSessions, type ImportUploadSessionLifecycle } from './useImportUploadSessions';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { readLocalSeriesManifest } from './local-series-import';
import { useImportController, type ImportFeatureController } from './useImportController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function selectedFiles(title: string, format: 'image_archive' | 'txt'): Promise<File[]> {
  if (format === 'txt') {
    return [1, 2].map(
      (index) => new File([`Chapter ${index}\n\n${title} content ${index}.`], `${title} Chapter ${index}.txt`),
    );
  }
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writer.add('001.png', new Uint8ArrayReader(png));
  return [new File([await writer.close()], `${title} Chapter 2.cbz`)];
}

const existingChapters = [testChapter(1, { documentSectionId: 'local_series_release_1' })];
function existingBook(id: string, format: 'image_archive' | 'txt') {
  return testNovel({
    id,
    title: 'Old Title',
    format,
    sourceAssetId: `${id}-source`,
    activeContentRevisionId: `${id}-revision`,
    documentSectionCount: 1,
  });
}

async function harness(
  input: {
    novels?: Novel[];
    importService?: ImportService;
    listNovels?: () => Promise<Novel[]>;
    listChapters?: (id: string) => Promise<Chapter[]>;
    getNovel?: (id: string) => Promise<Novel | undefined>;
    onImportCommitted?: (novel: Novel) => Promise<void>;
  } = {},
) {
  vi.stubGlobal('window', globalThis);
  let controller!: ImportFeatureController;
  const importFile = vi.fn<ImportService['importFile']>(() => ({
    jobId: 'fixture',
    cancel: vi.fn(),
    promise: Promise.resolve({ novel: testNovel({ title: 'New Title' }) }),
  }));
  const importService = input.importService ?? { importFile, supportsIncrementalImageSeriesAppend: true };
  function Harness() {
    controller = useImportController({
      importService,
      getNovel: input.getNovel ?? (async () => undefined),
      listNovels: input.listNovels ?? (async () => input.novels ?? []),
      listChapters: input.listChapters ?? (async () => []),
      onImportCommitted: input.onImportCommitted ?? (async () => undefined),
      notify: vi.fn(),
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    get controller() {
      return controller;
    },
    importFile,
    renderer,
  };
}

async function waitForState(check: () => boolean) {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  expect(check()).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

it('revalidates the remaining files and preserves the import settings after an exclusion', async () => {
  const h = await harness();
  const files = Array.from({ length: 6 }, (_, index) => new File(['body'], `independent-${index}.txt`));
  try {
    await act(async () => h.controller.selectFiles(files));
    act(() => h.controller.setEncoding('utf-8'));
    await act(async () => h.controller.removePendingFile(files[4]));
    expect(h.controller.pendingFiles).toEqual([files[0], files[1], files[2], files[3], files[5]]);
    expect(h.controller.encoding).toBe('utf-8');
    await act(async () => h.controller.selectFiles([files[4]]));
    await act(async () => h.controller.removePendingFile(files[4]));
    expect(h.controller.pendingFiles).toEqual([]);
  } finally {
    act(() => h.renderer.unmount());
  }
});

it('discards excluded chapters when a library lookup fails and retries the remaining selection', async () => {
  const novels = [existingBook('old', 'txt')];
  const listNovels = vi.fn(async () => novels);
  const h = await harness({ listNovels });
  const files = [...(await selectedFiles('Old Title', 'txt')), new File(['Third chapter'], 'Old Title Chapter 3.txt')];
  try {
    await act(async () => h.controller.selectFiles(files));
    await waitForState(() => !h.controller.seriesBusy && Boolean(h.controller.documentSeriesInspection));
    await act(async () => h.controller.setSeriesTargetNovel(undefined));
    expect(h.controller.documentSeriesPlan?.inspection.sources).toHaveLength(3);

    listNovels.mockRejectedValueOnce(new Error('offline'));
    await act(async () => h.controller.removePendingFile(files[1]));
    await act(async () => h.controller.setSeriesTargetNovel(novels[0].id));
    await act(async () => h.controller.setSeriesTargetNovel(undefined));
    await act(async () => h.controller.startPendingImport());
    expect(h.importFile).not.toHaveBeenCalled();
    expect(h.controller.pendingFiles).toEqual([files[0], files[2]]);
    expect(h.controller.documentSeriesInspection).toBeUndefined();
    expect(h.controller.documentSeriesPlan).toBeUndefined();
    expect(h.controller.preparationError).toBeTruthy();

    await act(async () => h.controller.retryPreparation());
    await waitForState(() => !h.controller.seriesBusy && Boolean(h.controller.documentSeriesPlan));
    expect(h.controller.preparationError).toBeUndefined();
    expect(h.controller.documentSeriesPlan?.targetNovel).toBeUndefined();
    await act(async () => h.controller.startPendingImport());
    expect(h.importFile).toHaveBeenCalledOnce();
    const { readDocumentSeriesArchive } = await import('@boaa/document-series-core');
    const archive = await readDocumentSeriesArchive(h.importFile.mock.calls[0]![0].file);
    expect(archive?.manifest.sources.map((source) => source.fileName)).toEqual([files[0].name, files[2].name]);
  } finally {
    act(() => h.renderer.unmount());
  }
});

it('rechecks a chosen series target when its chapter lookup temporarily fails', async () => {
  const novels = ['first', 'second'].map((id) => existingBook(id, 'image_archive'));
  const listChapters = vi.fn(async () => existingChapters);
  const h = await harness({ novels, listChapters });
  try {
    await act(async () => h.controller.selectFiles(await selectedFiles('Old Title', 'image_archive')));
    await waitForState(() => !h.controller.seriesBusy && Boolean(h.controller.seriesPlan));
    listChapters.mockRejectedValueOnce(new Error('offline'));
    await act(async () => h.controller.setSeriesTargetNovel('second'));
    expect(h.controller.preparationError).toBeTruthy();
    await act(async () => h.controller.retryPreparation());
    await waitForState(() => !h.controller.seriesBusy && Boolean(h.controller.seriesPlan));
    expect(h.controller.seriesPlan?.targetNovel?.id).toBe('second');
    expect(h.controller.preparationError).toBeUndefined();
  } finally {
    act(() => h.renderer.unmount());
  }
});

it.each(['close', 'replace'] as const)('ignores a failed inspection retry after %s', async (action) => {
  const retry = deferred<Novel[]>();
  const listNovels = vi.fn(async (): Promise<Novel[]> => []);
  listNovels.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => retry.promise);
  const h = await harness({ listNovels });
  const replacement = new File(['other body'], 'Other.txt');
  try {
    await act(async () => h.controller.selectFiles([new File(['body'], 'Old.txt')]));
    expect(h.controller.preparationError).toBeTruthy();
    await act(async () => h.controller.retryPreparation());
    if (action === 'close') await act(async () => h.controller.close());
    else await act(async () => h.controller.selectFiles([replacement]));
    await act(async () => retry.reject(new Error('late response')));
    expect(h.controller.preparationError).toBeUndefined();
    expect(h.controller.pendingFiles).toEqual(action === 'close' ? [] : [replacement]);
    expect(h.controller.isOpen).toBe(action === 'replace');
    await act(async () => h.controller.startPendingImport());
    if (action === 'close') expect(h.importFile).not.toHaveBeenCalled();
    else expect(h.importFile.mock.calls[0]![0].file).toBe(replacement);
  } finally {
    act(() => h.renderer.unmount());
  }
});

const completedSession: StoredUploadSessionEntry = {
  key: 'completed',
  uploadId: 'upload',
  fileName: 'saved.cbz',
  sizeBytes: 1,
  lastModified: 1,
  encoding: 'auto',
  chunkBytes: 1,
  totalChunks: 1,
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  expiresAt: '',
  completion: { bookId: 'saved', jobId: 'job', completedAt: '2026-07-10T00:00:00.000Z' },
};

describe('completed upload recovery', () => {
  it.each(['refresh', 'forget'] as const)(
    'blocks new selection and direct imports after reload until explicit %s',
    async (action) => {
      let sessions = [completedSession];
      const stored = testNovel({ id: 'saved', favorite: true });
      const onImportCommitted = vi.fn(async () => undefined);
      const service = {
        importFile: vi.fn(),
        listStoredUploadSessions: () => sessions,
        forgetStoredUploadSession: vi.fn(async () => {
          sessions = [];
        }),
        retryStoredUploadSession: vi.fn(async () => {
          sessions = [];
          return { novel: stored };
        }),
      };
      const view = await harness({ importService: service, onImportCommitted });
      const file = new File(['text'], 'new.txt');
      await act(async () => view.controller.selectFiles([file]));
      expect(view.controller.pendingFiles).toEqual([]);
      expect(view.controller.uploadSessions).toEqual([completedSession]);
      await act(async () => view.controller.importFiles([file]));
      expect(service.importFile).not.toHaveBeenCalled();
      if (action === 'refresh') {
        await act(async () => view.controller.retryUploadSession?.('completed'));
        expect(onImportCommitted).toHaveBeenCalledExactlyOnceWith(stored);
      } else {
        await act(async () => view.controller.forgetUploadSession('completed'));
        expect(onImportCommitted).not.toHaveBeenCalled();
      }
      expect(service.importFile).not.toHaveBeenCalled();
      expect(view.controller.uploadSessions).toEqual([]);
      await act(async () => view.controller.selectFiles([file]));
      await waitForState(() => !view.controller.duplicateBusy);
      expect(view.controller.pendingFiles).toEqual([file]);
      await act(async () => view.renderer.unmount());
    },
  );

  it.each(['recover', 'unmount', 'account'] as const)(
    'serializes receipt retries and fences late %s results',
    async (mode) => {
      const gate = deferred<{ novel: Novel }>();
      const recovered = vi.fn(async () => undefined);
      const notify = vi.fn();
      const service = {
        importFile: vi.fn(),
        listStoredUploadSessions: () => [completedSession],
        forgetStoredUploadSession: vi.fn(),
        retryStoredUploadSession: vi.fn(() => gate.promise),
      };
      let lifecycle!: ImportUploadSessionLifecycle;
      function Harness({ currentService = service }: { currentService?: ImportService }) {
        lifecycle = useImportUploadSessions(currentService, notify, recovered);
        return null;
      }
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Harness />);
      });
      let first!: Promise<void>;
      await act(async () => {
        first = lifecycle.retry('completed');
        void lifecycle.retry('completed');
      });
      expect(service.retryStoredUploadSession).toHaveBeenCalledOnce();
      expect(lifecycle.retryingKeys).toEqual(['completed']);
      if (mode === 'unmount') await act(async () => renderer.unmount());
      let nextRetry: Promise<void> | undefined;
      const nextGate = deferred<{ novel: Novel }>();
      if (mode === 'account') {
        const nextService = { ...service, retryStoredUploadSession: vi.fn(() => nextGate.promise) };
        await act(async () => renderer.update(<Harness currentService={nextService} />));
        expect(lifecycle.sessions).toEqual([]);
        expect(lifecycle.retryingKeys).toEqual([]);
        await act(async () => {
          nextRetry = lifecycle.retry('completed');
        });
        expect(nextService.retryStoredUploadSession).toHaveBeenCalledOnce();
      }
      const stored = testNovel({ id: 'saved' });
      await act(async () => {
        gate.resolve({ novel: stored });
        await first;
      });
      if (mode === 'recover') expect(recovered).toHaveBeenCalledExactlyOnceWith(stored);
      else {
        expect(recovered).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      }
      if (mode === 'account' && nextRetry) {
        expect(lifecycle.retryingKeys).toEqual(['completed']);
        await act(async () => {
          nextGate.resolve({ novel: stored });
          await nextRetry;
        });
        expect(recovered).toHaveBeenCalledExactlyOnceWith(stored);
        expect(lifecycle.retryingKeys).toEqual([]);
      }
      if (mode !== 'unmount') await act(async () => renderer.unmount());
    },
  );

  it('does not add a stale recovery warning after same-mount service replacement', async () => {
    vi.stubGlobal('window', globalThis);
    const callback = deferred<void>();
    const stored = testNovel({ id: 'saved' });
    const onImportCommitted = vi.fn(() => callback.promise);
    const notify = vi.fn();
    const firstService = {
      importFile: vi.fn(),
      listStoredUploadSessions: () => [completedSession],
      forgetStoredUploadSession: vi.fn(),
      retryStoredUploadSession: vi.fn(async () => ({ novel: stored })),
    };
    const nextService = { ...firstService, listStoredUploadSessions: () => [] };
    let controller!: ImportFeatureController;
    function Harness({ service }: { service: ImportService }) {
      controller = useImportController({
        importService: service,
        getNovel: async () => stored,
        listNovels: async () => [],
        listChapters: async () => [],
        onImportCommitted,
        notify,
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness service={firstService} />);
    });
    let retry!: Promise<void>;
    await act(async () => {
      retry = controller.retryUploadSession!('completed');
    });
    expect(onImportCommitted).toHaveBeenCalledExactlyOnceWith(stored);
    await act(async () => renderer.update(<Harness service={nextService} />));
    await act(async () => {
      callback.reject(new Error('old account callback failed'));
      await retry;
    });
    expect(controller.refreshPendingBooks).toEqual([]);
    expect(controller.uploadSessions).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('retries a first manifest failure using its canonical read without a second upload', async () => {
    const stored = testNovel({ id: 'saved' });
    const retry = vi.fn(async () => ({ novel: stored }));
    const acknowledge = vi.fn();
    const error = new ImportCommittedRefreshError('saved', retry, acknowledge);
    const importFile = vi.fn(() => ({ jobId: 'done', cancel: vi.fn(), promise: Promise.reject(error) }));
    const onImportCommitted = vi.fn(async () => undefined);
    const view = await harness({ importService: { importFile }, onImportCommitted });
    await act(async () => view.controller.selectFiles([new File(['text'], 'book.txt')]));
    await waitForState(() => !view.controller.duplicateBusy);
    await act(async () => view.controller.startPendingImport());
    expect(view.controller.batch).toMatchObject({ completed: 1, failed: 0 });
    expect(onImportCommitted).not.toHaveBeenCalled();
    await act(async () => view.controller.retryPendingRefresh?.());
    expect(retry).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(onImportCommitted).toHaveBeenCalledExactlyOnceWith(stored);
    expect(importFile).toHaveBeenCalledOnce();
    expect(view.controller.refreshPendingBooks).toEqual([]);
    await act(async () => view.renderer.unmount());
  });
});

describe('import preparation generations', () => {
  it('passes only the latest selected File digest and keeps replacement encoding/split choices', async () => {
    const oldFile = new File(['old'], 'book.txt', { lastModified: 1 });
    const newFile = new File(['new'], 'book.txt', { lastModified: 1 });
    const existing = testNovel({ sourceFileName: 'book.txt', rawTextHash: integrityHash('new') });
    const view = await harness({ novels: [existing], getNovel: async () => existing });
    await act(async () => view.controller.selectFiles([oldFile]));
    await waitForState(() => !view.controller.duplicateBusy);
    await act(async () => view.controller.selectFiles([newFile]));
    await waitForState(() => !view.controller.duplicateBusy);
    expect(view.controller.duplicateConflicts[0]?.kind).toBe('same_source');
    await act(async () => view.controller.setDuplicatePolicy(view.controller.duplicateConflicts[0].fileKey, 'replace'));
    await act(async () => {
      view.controller.setEncoding('utf-8');
      view.controller.setChapterSplitMode('single');
    });
    await waitForState(() => !view.controller.duplicateBusy);
    expect(view.controller.duplicateConflicts[0].policy).toBe('replace');
    await act(async () => view.controller.startPendingImport());
    expect(view.importFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        file: newFile,
        expectedSourceContentHash: integrityHash('new'),
        clientBookId: existing.id,
        encoding: 'utf-8',
        chapterSplitMode: 'single',
      }),
      expect.any(Function),
    );
    await act(async () => view.renderer.unmount());
  });

  it.each(['copy', 'skip', 'open_existing'] as const)('preserves the same-source %s choice', async (policy) => {
    const file = new File(['body'], 'book.txt');
    const existing = testNovel({ rawTextHash: integrityHash('body') });
    const view = await harness({ novels: [existing], getNovel: async () => existing });
    await act(async () => view.controller.selectFiles([file]));
    await waitForState(() => !view.controller.duplicateBusy);
    await act(async () => view.controller.setDuplicatePolicy(view.controller.duplicateConflicts[0].fileKey, policy));
    await act(async () => view.controller.startPendingImport());
    if (policy === 'copy') {
      expect(view.importFile).toHaveBeenCalledOnce();
      expect(view.importFile.mock.calls[0][0]).toMatchObject({
        file,
        expectedSourceContentHash: integrityHash('body'),
        clientBookId: expect.stringMatching(/^book_copy_/),
      });
    } else expect(view.importFile).not.toHaveBeenCalled();
    await act(async () => view.renderer.unmount());
  });

  it.each(['lookup', 'callback'] as const)(
    'retries a saved book after %s failure without uploading again',
    async (failure) => {
      const stored = testNovel({
        title: 'Canonical title',
        activeContentRevisionId: 'stored-revision',
        favorite: true,
      });
      const getNovel = vi.fn(async () => stored);
      const onImportCommitted = vi.fn(async () => undefined);
      if (failure === 'lookup') getNovel.mockRejectedValueOnce(new Error('temporary read failure'));
      else onImportCommitted.mockRejectedValueOnce(new Error('temporary callback failure'));
      const view = await harness({ getNovel, onImportCommitted });
      await act(async () => view.controller.selectFiles([new File(['text'], 'book.txt')]));
      await waitForState(() => !view.controller.duplicateBusy);
      await act(async () => view.controller.startPendingImport());
      expect(view.controller.batch).toMatchObject({ completed: 1, failed: 0 });
      expect(view.controller.refreshPendingBooks).toHaveLength(1);
      expect(view.controller.isOpen).toBe(true);
      await act(async () => view.controller.retryPendingRefresh?.());
      expect(view.importFile).toHaveBeenCalledOnce();
      expect(onImportCommitted).toHaveBeenLastCalledWith(stored);
      expect(view.controller.refreshPendingBooks).toEqual([]);
      await act(async () => view.renderer.unmount());
    },
  );

  it.each(['unmount', 'cancel', 'new_import'] as const)(
    'serializes refresh retries and ignores a stale read after %s',
    async (action) => {
      const stored = testNovel({ title: 'Canonical title' });
      const pending = deferred<Novel>();
      const getNovel = vi
        .fn(async () => stored)
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockImplementationOnce(() => pending.promise);
      const onImportCommitted = vi.fn(async () => undefined);
      const view = await harness({ getNovel, onImportCommitted });
      await act(async () => view.controller.selectFiles([new File(['body'], 'book.txt')]));
      await waitForState(() => !view.controller.duplicateBusy);
      await act(async () => view.controller.startPendingImport());
      let retry!: Promise<void>;
      await act(async () => {
        retry = view.controller.retryPendingRefresh!();
        await view.controller.retryPendingRefresh!();
      });
      expect(getNovel).toHaveBeenCalledTimes(2);
      if (action === 'unmount') await act(async () => view.renderer.unmount());
      else if (action === 'cancel') await act(async () => view.controller.cancelImport());
      else {
        await act(async () => view.controller.selectFiles([new File(['body'], 'book.txt')]));
        await waitForState(() => !view.controller.duplicateBusy);
        await act(async () => view.controller.startPendingImport());
        expect(view.controller.refreshPendingBooks).toEqual([]);
      }
      await act(async () => {
        pending.resolve(stored);
        await retry;
      });
      expect(onImportCommitted).toHaveBeenCalledTimes(action === 'new_import' ? 1 : 0);
      if (action !== 'unmount') await act(async () => view.renderer.unmount());
    },
  );

  it.each(['image_archive', 'txt'] as const)(
    'ignores obsolete %s planning and a start awaiting the replaced selection',
    async (format) => {
      const gate = deferred<Chapter[]>();
      const listChapters = vi.fn(() => gate.promise);
      const view = await harness({ novels: [existingBook('old', format)], listChapters });
      await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', format)));
      await waitForState(() => listChapters.mock.calls.length > 0);
      let obsoleteStart!: Promise<void>;
      await act(async () => {
        obsoleteStart = view.controller.startPendingImport();
      });
      await act(async () => view.controller.selectFiles(await selectedFiles('New Title', format)));
      await waitForState(
        () => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan ?? view.controller.documentSeriesPlan),
      );
      await act(async () => {
        gate.resolve(existingChapters);
        await obsoleteStart;
      });

      expect(view.importFile).not.toHaveBeenCalled();
      expect((view.controller.seriesPlan ?? view.controller.documentSeriesPlan)?.inspection.workTitle).toBe(
        'New Title',
      );
      expect(view.controller.seriesError).toBeUndefined();
      await act(async () => view.controller.startPendingImport());
      expect(view.importFile).toHaveBeenCalledOnce();
      expect(view.importFile.mock.calls[0]![0]).toMatchObject({
        clientBookId: undefined,
        expectedSourceContentHash: undefined,
        file: expect.objectContaining({ name: format === 'txt' ? 'New Title.boaa.zip' : 'New Title.cbz' }),
      });
      await act(async () => view.renderer.unmount());
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores a target plan that will %s after selecting other files',
    async (outcome) => {
      const gate = deferred<Chapter[]>();
      const first = existingBook('first', 'image_archive');
      const second = existingBook('second', 'image_archive');
      const listChapters = vi.fn(async (id: string) => (id === second.id ? gate.promise : existingChapters));
      const view = await harness({ novels: [first, second], listChapters });
      await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', 'image_archive')));
      await waitForState(() => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan));
      let pendingTarget!: Promise<void>;
      await act(async () => {
        pendingTarget = view.controller.setSeriesTargetNovel(second.id);
      });
      await act(async () => view.controller.selectFiles(await selectedFiles('New Title', 'image_archive')));
      await waitForState(
        () => !view.controller.seriesBusy && view.controller.seriesPlan?.inspection.workTitle === 'New Title',
      );
      await act(async () => {
        if (outcome === 'resolve') gate.resolve(existingChapters);
        else gate.reject(new Error('obsolete target failure'));
        await pendingTarget;
      });

      expect(view.controller.seriesPlan?.inspection.workTitle).toBe('New Title');
      expect(view.controller.seriesError).toBeUndefined();
      await act(async () => view.controller.startPendingImport());
      const request = view.importFile.mock.calls[0]![0];
      expect(request.clientBookId).toBeUndefined();
      expect((await readLocalSeriesManifest(request.file))?.collection.title).toBe('New Title');
      await act(async () => view.renderer.unmount());
    },
  );

  it('keeps the most recent target when competing target requests settle out of order', async () => {
    const firstTargetGate = deferred<Chapter[]>();
    const secondTargetGate = deferred<Chapter[]>();
    const books = ['initial', 'first', 'second'].map((id) => existingBook(id, 'image_archive'));
    const view = await harness({
      novels: books,
      listChapters: async (id) =>
        id === 'first' ? firstTargetGate.promise : id === 'second' ? secondTargetGate.promise : existingChapters,
    });
    await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', 'image_archive')));
    await waitForState(() => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan));
    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    await act(async () => {
      firstRequest = view.controller.setSeriesTargetNovel('first');
      secondRequest = view.controller.setSeriesTargetNovel('second');
    });
    await act(async () => {
      secondTargetGate.resolve(existingChapters);
      await secondRequest;
    });
    await act(async () => {
      firstTargetGate.reject(new Error('obsolete failure'));
      await firstRequest;
    });
    expect(view.controller.seriesTargetNovelId).toBe('second');
    expect(view.controller.seriesPlan?.targetNovel?.id).toBe('second');
    expect(view.controller.seriesError).toBeUndefined();
    expect(view.controller.seriesBusy).toBe(false);
    await act(async () => view.renderer.unmount());
  });

  it('uses the completed plan when start was called before inspection finished', async () => {
    const gate = deferred<Novel[]>();
    const view = await harness({ listNovels: () => gate.promise });
    await act(async () => view.controller.selectFiles(await selectedFiles('New Title', 'image_archive')));
    let starting!: Promise<void>;
    await act(async () => {
      starting = view.controller.startPendingImport();
    });
    await act(async () => {
      gate.resolve([]);
      await starting;
    });
    expect(view.importFile).toHaveBeenCalledOnce();
    expect((await readLocalSeriesManifest(view.importFile.mock.calls[0]![0].file))?.collection.title).toBe('New Title');
    await act(async () => view.renderer.unmount());
  });
});
