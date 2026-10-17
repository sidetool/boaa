import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { block, deferred, novel, repository, revision } from './pdf-text-controller-test-fixtures';
const runtime = vi.hoisted(() => ({ recognize: vi.fn(), dispose: vi.fn(), raster: vi.fn(), models: vi.fn() }));
vi.mock('../../providers/local-tesseract-ocr-provider', () => ({
  LocalTesseractOcrProvider: class {
    recognize = runtime.recognize;
    dispose = runtime.dispose;
  },
}));
vi.mock('./ocr/pdf-ocr', () => ({
  rasterizePdfPageForOcr: runtime.raster,
  buildOcrDocumentText: () => ({ revision: revision(), blocks: [block()] }),
}));
vi.mock('./ocr/ocr-language-model-cache', () => ({
  inspectOcrLanguageModelCache: runtime.models,
  removeOcrLanguageModelCache: vi.fn(),
}));
import { usePdfOcrController } from './use-pdf-ocr-controller';
beforeEach(() => {
  runtime.recognize.mockReset();
  runtime.dispose.mockReset().mockResolvedValue(undefined);
  runtime.raster.mockReset().mockResolvedValue({ image: new Blob(), pixelWidth: 100, pixelHeight: 100, dpi: 144 });
  runtime.models.mockReset().mockResolvedValue([]);
});
async function harness() {
  const repo = repository();
  const page = { cleanup: vi.fn() } as unknown as PDFPageProxy;
  const pdf = { numPages: 1, getPage: vi.fn(async () => page) } as unknown as PDFDocumentProxy;
  const text = {
    publishReady: vi.fn(async () => {}),
    markPageFailed: vi.fn(),
    preparePages: vi.fn(async () => [0]),
    textIndexProgress: undefined,
    interruptedOcrCount: 0,
  };
  const pages = new Map<number, PDFPageProxy>();
  let snapshot!: ReturnType<typeof usePdfOcrController>;
  function Probe({ id = novel.id, storage = repo }) {
    snapshot = usePdfOcrController({
      novel: { ...novel, id },
      pdf,
      pages,
      repository: storage,
      text,
      pageIndex: 0,
      totalPages: 1,
      searchOpen: false,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    repo,
    page,
    text,
    get current() {
      return snapshot;
    },
    update: async (id: string, storage = repo) => {
      await act(async () => root.update(<Probe id={id} storage={storage} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
it('cancels pending recognition without publishing and retires an uncached page and late worker', async () => {
  const pending = deferred<unknown>();
  runtime.recognize.mockReturnValue(pending.promise);
  const h = await harness();
  let job!: Promise<void>;
  await act(async () => {
    job = h.current.runOcrPages([0]);
  });
  expect(h.repo.saveRevision).toHaveBeenCalledOnce();
  act(() => h.current.cancelOcr());
  await act(async () => {
    pending.resolve({});
    await job;
  });
  expect(h.text.publishReady).not.toHaveBeenCalled();
  expect(h.repo.markRevisionStatus).toHaveBeenCalledWith(expect.any(String), 'failed', 'OCR 작업이 취소되었습니다.');
  expect(h.page.cleanup).toHaveBeenCalledOnce();
  expect(runtime.dispose).toHaveBeenCalledOnce();
  expect(h.current.ocrProgress).toBeUndefined();
  h.dispose();
});
it('fences OCR progress and ready publication across A→B→A while allowing a new job', async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  runtime.recognize.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const h = await harness();
  let old!: Promise<void>, next!: Promise<void>;
  await act(async () => {
    old = h.current.runOcrPages([0]);
  });
  const oldProgress = runtime.recognize.mock.calls[0][0].onProgress;
  await h.update('other');
  await h.update(novel.id);
  await act(async () => {
    next = h.current.runOcrPages([0]);
  });
  act(() => oldProgress(0.9, 'obsolete'));
  expect(h.current.ocrProgress?.status).not.toBe('obsolete');
  await act(async () => {
    first.resolve({});
    await old;
  });
  expect(h.text.publishReady).not.toHaveBeenCalled();
  expect(h.current.ocrProgress).toBeDefined();
  await act(async () => {
    second.resolve({});
    await next;
  });
  expect(h.text.publishReady).toHaveBeenCalledOnce();
  h.dispose();
});
it('does not publish after replacing the text repository while recognizing', async () => {
  const pending = deferred<unknown>();
  runtime.recognize.mockReturnValue(pending.promise);
  const h = await harness();
  let job!: Promise<void>;
  await act(async () => {
    job = h.current.runOcrPages([0]);
  });
  const replacement = repository();
  await h.update(novel.id, replacement);
  await act(async () => {
    pending.resolve({});
    await job;
  });
  expect(h.text.publishReady).not.toHaveBeenCalled();
  expect(replacement.markRevisionStatus).not.toHaveBeenCalled();
  expect(h.current.ocrProgress).toBeUndefined();
  h.dispose();
});
it('ignores a late model inventory after unmount', async () => {
  const pending = deferred<never[]>();
  runtime.models.mockReturnValue(pending.promise);
  const h = await harness();
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = h.current.refreshOcrModelCache();
  });
  h.dispose();
  await act(async () => {
    pending.resolve([]);
    await refresh;
  });
  expect(runtime.models).toHaveBeenCalledOnce();
});

it('rejects retained old-document model and cancellation commands before touching a new OCR job', async () => {
  const pending = deferred<unknown>();
  runtime.recognize.mockReturnValue(pending.promise);
  const h = await harness();
  const old = h.current;
  await h.update('other');
  let job!: Promise<void>;
  await act(async () => {
    job = h.current.runOcrPages([0]);
  });
  const signal = runtime.recognize.mock.calls[0][1] as AbortSignal;
  await act(async () => {
    old.cancelOcr();
    await old.unloadOcrWorker();
    await old.refreshOcrModelCache();
    await old.removeOcrModel('eng');
  });
  expect(signal.aborted).toBe(false);
  expect(runtime.dispose).not.toHaveBeenCalled();
  expect(runtime.models).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({});
    await job;
  });
  expect(h.text.publishReady).toHaveBeenCalledOnce();
  h.dispose();
});
