import type { TTSDownloadJob } from '../../domain/types';
import type { TTSDownloadRepository } from '../../repositories/tts-download-repository';
import type { HostedTTSOperationToken, useTTSExecutionController } from './useTTSExecutionController';
import type { NativeTTSWarmupObserver } from './native-tts-warmup-runner';

export type TTSWarmupExecutionPort = Pick<
  ReturnType<typeof useTTSExecutionController>,
  | 'beginWarmup'
  | 'cancelWarmup'
  | 'operationIsCurrent'
  | 'finishOperation'
  | 'setHostedStatus'
  | 'setHostedJob'
  | 'pollHostedJob'
>;
export interface TTSWarmupExecution {
  readonly operation: HostedTTSOperationToken;
  readonly controller: TTSWarmupExecutionPort;
  readonly current: () => boolean;
  readonly notify: (message: string, tone: 'warning' | 'success') => void;
}
export interface TTSWarmupDownload {
  readonly repository: TTSDownloadRepository;
  readonly job: TTSDownloadJob;
  settled?: boolean;
}
export async function finishWarmupDownload(download: TTSWarmupDownload, state: TTSDownloadJob['state']) {
  const result = await download.repository.finish(download.job.id, state);
  download.settled = true;
  return result;
}
export function assertWarmupCurrent(execution: TTSWarmupExecution): void {
  if (!execution.current()) throw new DOMException('TTS preparation context changed', 'AbortError');
}
export function downloadObserver({ repository, job }: TTSWarmupDownload): NativeTTSWarmupObserver {
  return {
    planned: (items) => repository.planItems(job.id, items),
    running: (hash) => repository.markItemRunning(job.id, hash),
    retrying: (hash, error, nextAttemptAt) =>
      repository.markItemRetryWait(job.id, hash, error instanceof Error ? error.message : String(error), nextAttemptAt),
    ready: (hash, result) =>
      repository.markItemReady(job.id, hash, { cacheKey: result.cacheKey, byteSize: result.byteSize }),
    failed: (hash, error) =>
      repository.markItemFailed(job.id, hash, error instanceof Error ? error.message : String(error)),
  };
}
