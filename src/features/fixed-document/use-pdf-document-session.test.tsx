import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { BookAssetRepository, RandomAccessBookSource } from '../../repositories/book-asset-repository';

const runtime = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: runtime.getDocument,
  PDFDataRangeTransport: class {},
}));
import { usePdfDocumentSession } from './use-pdf-document-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function source(): RandomAccessBookSource {
  return {
    byteLength: 200000,
    contentType: 'application/pdf',
    contentHash: 'fixture',
    readRange: vi.fn(async (start, end) => new Uint8Array(end - start)),
    close: vi.fn(async () => {}),
  };
}
function document() {
  const pages = new Map<number, PDFPageProxy>();
  const getPage = vi.fn(async (index: number) => {
    if (!pages.has(index)) pages.set(index, { cleanup: vi.fn() } as unknown as PDFPageProxy);
    return pages.get(index)!;
  });
  return { pdf: { numPages: 100, getPage } as unknown as PDFDocumentProxy, pages, getPage };
}
async function harness(openSource: BookAssetRepository['openSource'] = vi.fn(async () => source())) {
  let snapshot!: ReturnType<typeof usePdfDocumentSession>;
  const assets = { openSource };
  function Probe({
    revision = 'one',
    wanted = [0],
    page = 0,
  }: {
    revision?: string;
    wanted?: number[];
    page?: number;
  }) {
    snapshot = usePdfDocumentSession({
      enabled: true,
      bookId: 'book',
      sourceRevision: revision,
      assets,
      wantedPages: new Set(wanted),
      currentPage: page,
      totalPages: 100,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    get snapshot() {
      return snapshot;
    },
    update: async (props: Parameters<typeof Probe>[0]) => {
      await act(async () => root.update(<Probe {...props} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
beforeEach(() => runtime.getDocument.mockReset());

it('closes a source that arrives after unmount without starting a worker', async () => {
  const pending = deferred<RandomAccessBookSource>();
  const h = await harness(vi.fn(() => pending.promise));
  h.dispose();
  const resource = source();
  await act(async () => {
    pending.resolve(resource);
    await pending.promise;
  });
  expect(resource.close).toHaveBeenCalledOnce();
  expect(runtime.getDocument).not.toHaveBeenCalled();
});

it('aborts the initial range read and closes its source before PDF.js starts', async () => {
  const header = deferred<Uint8Array>();
  const resource = source();
  resource.readRange = vi.fn(() => header.promise);
  const h = await harness(vi.fn(async () => resource));
  const signal = vi.mocked(resource.readRange).mock.calls[0][2]!;
  h.dispose();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    header.resolve(new Uint8Array(20));
    await header.promise;
  });
  expect(resource.close).toHaveBeenCalledOnce();
  expect(runtime.getDocument).not.toHaveBeenCalled();
});

it('destroys an unresolved loading task and preserves bounded range options', async () => {
  const pending = deferred<PDFDocumentProxy>();
  const destroy = vi.fn(async () => {});
  runtime.getDocument.mockReturnValue({ promise: pending.promise, destroy });
  const resource = source();
  const h = await harness(vi.fn(async () => resource));
  expect(runtime.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({ rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true }),
  );
  h.dispose();
  expect(destroy).toHaveBeenCalledOnce();
  expect(resource.close).toHaveBeenCalledOnce();
  await act(async () => {
    pending.resolve(document().pdf);
    await pending.promise;
  });
  expect(h.snapshot.pdf).toBeUndefined();
});

it('cleans late pages and isolates a replacement content revision', async () => {
  const old = document();
  const next = document();
  const pendingPage = deferred<PDFPageProxy>();
  old.getPage.mockImplementationOnce(() => pendingPage.promise);
  const destroyOld = vi.fn(async () => {});
  runtime.getDocument
    .mockReturnValueOnce({ promise: Promise.resolve(old.pdf), destroy: destroyOld })
    .mockReturnValueOnce({ promise: Promise.resolve(next.pdf), destroy: vi.fn(async () => {}) });
  const h = await harness();
  await h.update({ revision: 'two' });
  const obsolete = { cleanup: vi.fn() } as unknown as PDFPageProxy;
  await act(async () => {
    pendingPage.resolve(obsolete);
    await pendingPage.promise;
  });
  expect(destroyOld).toHaveBeenCalledOnce();
  expect(obsolete.cleanup).toHaveBeenCalledOnce();
  expect(h.snapshot.pdf).toBe(next.pdf);
  expect(h.snapshot.pdfPages.get(0)).toBe(next.pages.get(1));
  h.dispose();
  expect(next.pages.get(1)!.cleanup).toHaveBeenCalledOnce();
});

it('deduplicates page requests and evicts distant pages after the 20-page threshold', async () => {
  const doc = document();
  runtime.getDocument.mockReturnValue({ promise: Promise.resolve(doc.pdf), destroy: vi.fn(async () => {}) });
  const h = await harness();
  await h.update({ wanted: Array.from({ length: 21 }, (_, index) => index) });
  expect(h.snapshot.pdfPages.size).toBe(21); // Wanted pages are protected, as before.
  expect(doc.getPage).toHaveBeenCalledTimes(21);
  await h.update({ wanted: [20], page: 20 });
  expect(h.snapshot.pdfPages.size).toBe(4);
  expect(doc.pages.get(1)!.cleanup).toHaveBeenCalledOnce();
  expect(doc.pages.get(21)!.cleanup).not.toHaveBeenCalled();
  h.dispose();
});

it('keeps missing-source errors in the existing failed-state UI contract', async () => {
  const h = await harness(vi.fn(async () => undefined));
  expect(h.snapshot).toMatchObject({
    status: 'failed',
    errorMessage: 'PDF 원본을 찾을 수 없습니다. 원본 파일을 다시 연결해 주세요.',
  });
  h.dispose();
});

it('closes the source once when unmount falls between range creation and ownership transfer', async () => {
  const header = deferred<Uint8Array>();
  const resource = source();
  resource.readRange = vi.fn(() => header.promise);
  const h = await harness(vi.fn(async () => resource));
  await act(async () => {
    header.resolve(new Uint8Array(20));
    queueMicrotask(() => h.dispose());
    await header.promise;
  });
  expect(resource.close).toHaveBeenCalledOnce();
  expect(runtime.getDocument).not.toHaveBeenCalled();
});
