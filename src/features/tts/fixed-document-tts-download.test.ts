import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DocumentTextBlock, DocumentTextRevision } from '../../domain/types';
import { IndexedDbTTSDownloadRepository } from '../../storage/tts-download-store';
import { resetReaderDbForTests } from '../../storage/reader-database';
import {
  planFixedDocumentTTS,
  runFixedDocumentTTSDownload,
  type FixedDocumentTTSPlanInput,
  type FixedDocumentTTSTransport,
} from './fixed-document-tts-download';
import type { TTSWarmupExecution } from './tts-warmup-execution';
import type { runHostedTTSDownloadQueue } from './hosted-tts-download-queue';
import type { runNativeTTSWarmup } from './native-tts-warmup-runner';
const mocks = vi.hoisted(() => ({
  hosted: vi.fn<typeof runHostedTTSDownloadQueue>(),
  native: vi.fn<typeof runNativeTTSWarmup>(),
}));
vi.mock('./hosted-tts-download-queue', () => ({ runHostedTTSDownloadQueue: mocks.hosted }));
vi.mock('./native-tts-warmup-runner', () => ({ runNativeTTSWarmup: mocks.native }));
beforeEach(async () => {
  vi.clearAllMocks();
  await resetReaderDbForTests();
});
function setup() {
  const operation = {
    lane: 'warmup' as const,
    bookId: 'book',
    chapterId: 'fixed_document_book',
    controller: new AbortController(),
  };
  const execution: TTSWarmupExecution = {
    operation,
    current: () => !operation.controller.signal.aborted,
    notify: vi.fn(),
    controller: {
      beginWarmup: () => operation,
      cancelWarmup: () => operation.controller.abort(),
      operationIsCurrent: () => !operation.controller.signal.aborted,
      finishOperation: () => true,
      setHostedJob: vi.fn(() => true),
      setHostedStatus: vi.fn(() => true),
      pollHostedJob: vi.fn(),
    },
  };
  const revisions: DocumentTextRevision[] = [0, 1, 49, 50].map((pageIndex) => ({
    id: `text-${pageIndex}`,
    bookId: 'book',
    pageIndex,
    pageHash: `page-${pageIndex}`,
    source: pageIndex === 1 ? 'ocr' : 'pdf_native',
    qualityScore: 0.1,
    engine: 'synthetic',
    engineVersion: '1',
    status: 'ready',
    createdAt: 'now',
    updatedAt: 'now',
  }));
  const input: FixedDocumentTTSPlanInput = {
    novel: { id: 'book' },
    repository: {
      listReadyRevisions: vi.fn(async () => revisions),
      getBlocks: vi.fn(async (id: string): Promise<DocumentTextBlock[]> => {
        const revision = revisions.find((entry) => entry.id === id)!;
        return [
          {
            id: `block-${revision.pageIndex}`,
            revisionId: id,
            bookId: 'book',
            pageIndex: revision.pageIndex,
            order: 0,
            role: 'paragraph',
            text: 'Synthetic sentence.',
            normalizedText: 'Synthetic sentence.',
            quads: [],
            direction: 'ltr',
          },
        ];
      }),
    },
    speech: { rate: 1 },
    voices: {
      contentRevision: 'v1',
      chapters: Array.from({ length: 51 }, (_, index) => ({
        id: `chapter-${index}`,
        novelId: 'book',
        index,
        title: 'page',
        normalizedText: '',
        textHash: 'hash',
        rawStartOffset: 0,
        rawEndOffset: 0,
        characterCount: 0,
        paragraphCount: 0,
        createdAt: 'now',
        updatedAt: 'now',
      })),
      voiceProfiles: [
        {
          id: 'voice',
          novelId: 'book',
          role: 'narrator',
          providerId: 'openai-tts',
          providerVoiceId: 'alloy',
          label: 'Narrator',
          speed: 1,
          isUserSelected: true,
          updatedAt: 'now',
        },
      ],
    },
  };
  return { input, execution };
}
it('limits to 50 pages, filters low OCR, and preserves exact source provenance and speech anchors', async () => {
  const { input, execution } = setup();
  const plan = await planFixedDocumentTTS(input, 50, 0, execution);
  expect(input.repository.getBlocks).toHaveBeenCalledTimes(3);
  expect(plan?.sources.map((source) => source.revision.id)).toEqual(['text-0', 'text-49']);
  expect(plan?.chapterIds).toEqual(['chapter-0', 'chapter-49']);
  expect(plan?.requests[1].request.renderSpec).toMatchObject({
    contentRevision: 'v1',
    chapterId: 'chapter-49',
    segmentAnchors: [expect.objectContaining({ paragraphId: 'block-49' })],
  });
  expect(execution.notify).toHaveBeenCalledWith(expect.stringContaining('OCR'), 'warning');
});
it('uploads original revision/block snapshots before hosted synthesis and stops after cancellation during upload', async () => {
  const { input, execution } = setup();
  const plan = (await planFixedDocumentTTS(input, 0, 0, execution))!;
  const repository = new IndexedDbTTSDownloadRepository(),
    job = await repository.create({
      bookId: 'book',
      contentRevisionId: 'v1',
      chapterIds: plan.chapterIds,
      wholeBook: false,
    });
  const transport: FixedDocumentTTSTransport = {
    client: {
      saveDocumentTextPage: vi.fn(async () => {
        execution.operation.controller.abort();
        return { revisionId: 'text-0', blockCount: 1 };
      }),
      resolveTTSCache: vi.fn(),
      fetchTTSCacheAudio: vi.fn(),
    },
    cache: { getByCacheKey: vi.fn(), put: vi.fn() },
  };
  await expect(
    runFixedDocumentTTSDownload(plan, { native: false, transport }, { repository, job }, execution),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport.client.saveDocumentTextPage).toHaveBeenCalledWith(
    'book',
    plan.sources[0].revision,
    plan.sources[0].blocks,
    execution.operation.controller.signal,
  );
  expect(mocks.hosted).not.toHaveBeenCalled();
});
it('routes native provenance through the durable observer and includes source failures in terminal state', async () => {
  const { input, execution } = setup();
  const plan = (await planFixedDocumentTTS(input, 0, 0, execution))!;
  const repository = new IndexedDbTTSDownloadRepository(),
    job = await repository.create({
      bookId: 'book',
      contentRevisionId: 'v1',
      chapterIds: plan.chapterIds,
      wholeBook: false,
    });
  mocks.native.mockImplementationOnce(async (value) => {
    const source = await value.loadChapterSource(value.chapters[0], value.signal);
    expect(source?.paragraphs[0]).toMatchObject({
      id: plan.requests[0].paragraphId,
      text: plan.requests[0].text,
      textHash: plan.requests[0].request.inputTextHash,
    });
    expect(await value.buildRequests(source ? [source] : [])).toEqual(plan.requests);
    await value.observer?.planned([
      { chapterId: 'chapter-0', paragraphId: plan.requests[0].paragraphId, renderSpecHash: 'hash', cacheKey: 'hash' },
    ]);
    await value.observer?.ready('hash', { cacheKey: 'audio', byteSize: 20, cacheHit: false });
    return {
      total: 1,
      completed: 1,
      failed: 0,
      sourceFailures: 1,
      cacheHits: 0,
      rendered: 1,
      chapters: 1,
      aborted: false,
    };
  });
  await runFixedDocumentTTSDownload(
    plan,
    { native: true, gateway: { runtime: 'native', render: vi.fn(), inspect: vi.fn() } },
    { repository, job },
    execution,
  );
  expect(await repository.get(job.id)).toMatchObject({ state: 'partial', readyItems: 1, byteSize: 20 });
  expect(mocks.hosted).not.toHaveBeenCalled();
  expect(execution.notify).toHaveBeenLastCalledWith(expect.stringContaining('1/1'), 'warning');
});
