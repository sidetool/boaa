import type { HostedTTSWarmupRequest } from '../../providers/hosted-tts-warmup';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import type { IndexedDbHostedTTSOfflineCache } from '../../storage/hosted-tts-offline-cache';
import { ttsRenderSpecHash } from '../../providers/tts-render-spec';
import { abortableDelay, isAbortError } from '../../utils/async';
import { assertWarmupCurrent, type TTSWarmupDownload, type TTSWarmupExecution } from './tts-warmup-execution';

export interface HostedTTSDownloadTransport {
  readonly client: Pick<RemoteApiClient, 'resolveTTSCache' | 'fetchTTSCacheAudio'>;
  readonly cache: Pick<IndexedDbHostedTTSOfflineCache, 'getByCacheKey' | 'put'>;
}
/** Couples the existing bounded retry queue to durable download items and the offline audio cache. */
export async function runHostedTTSDownloadQueue(
  requests: HostedTTSWarmupRequest[],
  transport: HostedTTSDownloadTransport,
  download: TTSWarmupDownload,
  execution: TTSWarmupExecution,
) {
  const { runHostedTTSWarmupQueue } = await import('../../providers/hosted-tts-warmup-runner');
  assertWarmupCurrent(execution);
  const { repository, job } = download;
  await repository.planItems(
    job.id,
    requests.flatMap((request) => {
      if (!request.request.renderSpec) return [];
      const hash = ttsRenderSpecHash(request.request.renderSpec);
      return [{ chapterId: request.chapterId, paragraphId: request.paragraphId, cacheKey: hash, renderSpecHash: hash }];
    }),
  );
  assertWarmupCurrent(execution);
  return runHostedTTSWarmupQueue({
    requests,
    signal: execution.operation.controller.signal,
    resolveCache: (request, signal) => {
      assertWarmupCurrent(execution);
      return transport.client.resolveTTSCache(request.chapterId, request.request, signal);
    },
    pollJob: (job, signal) => {
      assertWarmupCurrent(execution);
      return execution.controller.pollHostedJob(job.id, signal, { operation: execution.operation });
    },
    fetchAudio: async (request, resolved, signal) => {
      assertWarmupCurrent(execution);
      const cached = await transport.cache.getByCacheKey(job.bookId, resolved.cacheKey).catch(() => undefined);
      assertWarmupCurrent(execution);
      if (cached) return cached.blob;
      const audio = await transport.client.fetchTTSCacheAudio(request.chapterId, resolved.cacheKey, signal);
      assertWarmupCurrent(execution);
      const spec = request.request.renderSpec;
      if (!spec) throw new Error('Hosted TTS render specification is missing.');
      await transport.cache.put({
        bookId: job.bookId,
        chapterId: request.chapterId,
        cacheKey: resolved.cacheKey,
        renderSpecHash: ttsRenderSpecHash(spec),
        contentRevisionId: job.contentRevisionId,
        blob: audio,
      });
      return audio;
    },
    onRequestStart: (request) => {
      assertWarmupCurrent(execution);
      if (request.request.renderSpec)
        return repository.markItemRunning(job.id, ttsRenderSpecHash(request.request.renderSpec));
    },
    onRequestReady: (request, resolved, audio) => {
      assertWarmupCurrent(execution);
      if (request.request.renderSpec && audio)
        return repository.markItemReady(job.id, ttsRenderSpecHash(request.request.renderSpec), {
          cacheKey: resolved.cacheKey,
          byteSize: audio.size,
          storage: 'indexeddb',
        });
    },
    onRequestFailed: (request, error) => {
      assertWarmupCurrent(execution);
      if (request.request.renderSpec)
        return repository.markItemFailed(
          job.id,
          ttsRenderSpecHash(request.request.renderSpec),
          error instanceof Error ? error.message : String(error),
        );
    },
    onRequestRetry: (request, error, at) => {
      assertWarmupCurrent(execution);
      if (request.request.renderSpec)
        return repository.markItemRetryWait(
          job.id,
          ttsRenderSpecHash(request.request.renderSpec),
          error instanceof Error ? error.message : String(error),
          at,
        );
    },
    retryLimit: job.policy.retryLimit,
    wait: abortableDelay,
    isAbortError,
    onStatus: (status) => {
      if (execution.current()) execution.controller.setHostedStatus(execution.operation, status);
    },
    onJob: (job) => {
      if (execution.current()) execution.controller.setHostedJob(execution.operation, job);
    },
  });
}
