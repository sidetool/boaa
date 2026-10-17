import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { annotations, block, deferred, novel, repository, revision } from './pdf-text-controller-test-fixtures';
const native = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('./text/pdf-native-text', () => ({
  extractPdfNativeText: native.extract,
  pdfNativeTextRevisionId: () => 'native-id',
}));
import { usePdfTextSession } from './use-pdf-text-session';
import { publishPdfTextRevision } from './text/pdf-text-publication';
const result = () => ({ revision: revision(), blocks: [block()], needsOcr: false });
beforeEach(() => native.extract.mockReset());
async function harness(initialRepository = repository(), pdf?: PDFDocumentProxy) {
  const annotationRepository = annotations();
  const page = { cleanup: vi.fn() } as unknown as PDFPageProxy;
  const pages = new Map<number, PDFPageProxy>();
  let snapshot!: ReturnType<typeof usePdfTextSession>;
  function Probe({ id = novel.id, repo = initialRepository }) {
    snapshot = usePdfTextSession({
      novel: { ...novel, id },
      pdf,
      pages,
      displayedPageKey: '',
      repository: repo,
      annotations: annotationRepository,
      onAnnotations: vi.fn(),
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    get current() {
      return snapshot;
    },
    page,
    update: async (id: string, repo = initialRepository) => {
      await act(async () => root.update(<Probe id={id} repo={repo} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
it('does not publish a deferred native extraction after A→B→A and allows the new A extraction', async () => {
  const pending = deferred<ReturnType<typeof result>>();
  native.extract.mockReturnValueOnce(pending.promise).mockResolvedValue(result());
  const repo = repository();
  const h = await harness(repo);
  let old!: Promise<void>;
  await act(async () => {
    old = h.current.ensurePdfNativeText(0, h.page);
  });
  await h.update('other');
  await h.update(novel.id);
  await act(async () => h.current.ensurePdfNativeText(0, h.page));
  await act(async () => {
    pending.resolve(result());
    await old;
  });
  expect(repo.saveReadyPage).toHaveBeenCalledTimes(1);
  expect(h.current.textBlocksByPage.has(0)).toBe(true);
  h.dispose();
});
it('fences extraction when the repository changes under the same document', async () => {
  const pending = deferred<ReturnType<typeof result>>();
  native.extract.mockReturnValue(pending.promise);
  const oldRepo = repository(),
    newRepo = repository();
  const h = await harness(oldRepo);
  let work!: Promise<void>;
  await act(async () => {
    work = h.current.ensurePdfNativeText(0, h.page);
  });
  await h.update(novel.id, newRepo);
  await act(async () => {
    pending.resolve(result());
    await work;
  });
  expect(oldRepo.saveReadyPage).not.toHaveBeenCalled();
  expect(newRepo.saveReadyPage).not.toHaveBeenCalled();
  expect(h.current.textBlocksByPage.size).toBe(0);
  h.dispose();
});
it('cleans an uncached page arriving after indexing cancellation without extracting it', async () => {
  const pending = deferred<PDFPageProxy>();
  const pdf = { numPages: 1, getPage: vi.fn(() => pending.promise) } as unknown as PDFDocumentProxy;
  const h = await harness(repository(), pdf);
  let work!: Promise<void>;
  await act(async () => {
    work = h.current.indexAllPdfText();
  });
  act(() => h.current.cancelIndex());
  await act(async () => {
    pending.resolve(h.page);
    await work;
  });
  expect(h.page.cleanup).toHaveBeenCalledOnce();
  expect(native.extract).not.toHaveBeenCalled();
  expect(h.current.textIndexProgress).toBeUndefined();
  h.dispose();
});
it('finishes captured ready→remap→pending retirement→active blocks ordering after commit even when cancelled', async () => {
  const events: string[] = [];
  const committed = deferred<void>();
  const repo = repository();
  const anns = annotations();
  const abort = new AbortController();
  vi.mocked(repo.saveReadyPage).mockImplementation(async () => {
    events.push('ready');
    await committed.promise;
  });
  vi.mocked(anns.listPage).mockImplementation(async () => {
    events.push('remap');
    return [];
  });
  vi.mocked(repo.markRevisionStatus).mockImplementation(async () => {
    events.push('retire');
  });
  vi.mocked(repo.getBlocks).mockImplementation(async () => {
    events.push('blocks');
    return [block()];
  });
  const work = publishPdfTextRevision({
    repository: repo,
    annotations: anns,
    ...result(),
    pendingRevisionId: 'pending',
    signal: abort.signal,
  });
  abort.abort();
  committed.resolve();
  await work;
  expect(events).toEqual(['ready', 'remap', 'retire', 'blocks']);
  await expect(
    publishPdfTextRevision({ repository: repo, annotations: anns, ...result(), signal: abort.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(repo.saveReadyPage).toHaveBeenCalledOnce();
});

it('keeps shared visible-page extraction alive when its first indexing consumer cancels', async () => {
  const pending = deferred<ReturnType<typeof result>>();
  native.extract.mockReturnValue(pending.promise);
  const repo = repository();
  const h = await harness(repo);
  const controller = new AbortController();
  let indexing!: Promise<unknown>, visible!: Promise<void>;
  await act(async () => {
    indexing = h.current.ensurePdfNativeText(0, h.page, controller.signal).catch((error: unknown) => error);
  });
  await act(async () => {
    visible = h.current.ensurePdfNativeText(0, h.page);
  });
  controller.abort();
  await act(async () => {
    pending.resolve(result());
    await visible;
  });
  expect(await indexing).toMatchObject({ name: 'AbortError' });
  expect(native.extract).toHaveBeenCalledOnce();
  expect(repo.saveReadyPage).toHaveBeenCalledOnce();
  expect(h.current.textBlocksByPage.has(0)).toBe(true);
  h.dispose();
});
