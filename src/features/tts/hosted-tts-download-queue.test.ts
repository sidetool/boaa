import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { IndexedDbTTSDownloadRepository } from '../../storage/tts-download-store';
import { IndexedDbHostedTTSOfflineCache } from '../../storage/hosted-tts-offline-cache';
import { resetReaderDbForTests } from '../../storage/reader-database';
import { runHostedTTSDownloadQueue } from './hosted-tts-download-queue';
import type { TTSWarmupExecution } from './tts-warmup-execution';
import type { HostedTTSWarmupRequest } from '../../providers/hosted-tts-warmup';
import { ttsRenderSpecHash } from '../../providers/tts-render-spec';
beforeEach(async () => {
  await resetReaderDbForTests();
});
const request: HostedTTSWarmupRequest = {
  requestKey: 'request',
  chapterId: 'chapter',
  paragraphId: 'paragraph',
  paragraphIndex: 0,
  speakerLabel: 'Narrator',
  text: 'Synthetic text',
  request: {
    providerId: 'synthetic',
    voiceProfileId: 'voice',
    speakerId: 'narrator',
    segmentIds: ['segment'],
    inputTextHash: 'text',
    renderSpec: {
      novelId: 'book',
      chapterId: 'chapter',
      contentRevision: 'revision',
      speakerId: 'narrator',
      voiceProfileId: 'voice',
      providerId: 'synthetic',
      segmentAnchors: [{ segmentId: 'segment' }],
      inputTextHash: 'text',
      providerOptionsHash: 'options',
      format: 'mp3',
      speed: 1,
    },
  },
};
async function setup() {
  const repository = new IndexedDbTTSDownloadRepository();
  const cache = new IndexedDbHostedTTSOfflineCache();
  const job = await repository.create({
    bookId: 'book',
    contentRevisionId: 'revision',
    chapterIds: ['chapter'],
    wholeBook: false,
  });
  const operation = {
    lane: 'warmup' as const,
    bookId: 'book',
    chapterId: 'chapter',
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
      pollHostedJob: async () => {
        throw new Error('unused');
      },
    },
  };
  const client = {
    resolveTTSCache: vi.fn(async () => ({ cacheHit: true, cacheKey: 'cache', optionsHash: 'options' })),
    fetchTTSCacheAudio: vi.fn(async () => new Blob(['audio'], { type: 'audio/mpeg' })),
  };
  return { repository, cache, job, execution, client };
}
it('persists the exact render hash, audio and ready item before reporting completion, then reuses cached audio', async () => {
  const h = await setup();
  const summary = await runHostedTTSDownloadQueue([request], h, h, h.execution);
  expect(summary).toMatchObject({ completed: 1, failed: 0 });
  const hash = ttsRenderSpecHash(request.request.renderSpec!);
  expect(await h.repository.listItems(h.job.id)).toEqual([
    expect.objectContaining({ renderSpecHash: hash, cacheKey: 'cache', state: 'ready', byteSize: 5 }),
  ]);
  expect(await h.cache.getByRenderSpecHash('book', hash)).toMatchObject({ cacheKey: 'cache', byteSize: 5 });
  await runHostedTTSDownloadQueue([request], h, h, h.execution);
  expect(h.client.fetchTTSCacheAudio).toHaveBeenCalledOnce();
});
it('does not cache or mark audio ready when the generation is cancelled while fetching', async () => {
  const h = await setup();
  let resolve!: (audio: Blob) => void;
  h.client.fetchTTSCacheAudio.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const pending = runHostedTTSDownloadQueue([request], h, h, h.execution);
  await vi.waitFor(() => expect(h.client.fetchTTSCacheAudio).toHaveBeenCalledOnce());
  h.execution.operation.controller.abort();
  resolve(new Blob(['audio']));
  expect(await pending).toMatchObject({ aborted: true, completed: 0 });
  expect(await h.cache.getByCacheKey('book', 'cache')).toBeUndefined();
  expect((await h.repository.listItems(h.job.id))[0].state).toBe('running');
  expect(await h.repository.cancel(h.job.id)).toMatchObject({ state: 'cancelled', readyItems: 0 });
});
