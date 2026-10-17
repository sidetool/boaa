import type { Chapter } from '../../domain/types';
import type { NativeTTSCacheControllerInput } from './native-tts-cache-controller';
import {
  assertWarmupCurrent,
  downloadObserver,
  finishWarmupDownload,
  type TTSWarmupDownload,
  type TTSWarmupExecution,
} from './tts-warmup-execution';
import { formatBytes } from '../../utils/format';

export type NativeTTSCacheContextLoader = () => Promise<{
  module: typeof import('./native-tts-cache-controller');
  input: NativeTTSCacheControllerInput;
}>;
export async function runNativeTTSDownload(
  loadContext: NativeTTSCacheContextLoader,
  chapters: readonly Chapter[],
  wholeBook: boolean,
  download: TTSWarmupDownload,
  execution: TTSWarmupExecution,
): Promise<void> {
  const { module, input } = await loadContext();
  assertWarmupCurrent(execution);
  const { repository, job } = download;
  const summary = await module.runNativeTTSCacheOperation(
    {
      ...input,
      adoptWorkflow: (...args) => (execution.current() ? input.adoptWorkflow(...args) : false),
      notify: execution.notify,
    },
    'render',
    chapters,
    execution.operation.controller.signal,
    {
      fullScan: wholeBook,
      retryLimit: job.policy.retryLimit,
      recoveryPolicy: { network: job.policy.network, charging: job.policy.charging },
      onStatus: (status) => {
        if (execution.current()) execution.controller.setHostedStatus(execution.operation, status);
      },
      observer: downloadObserver(download),
    },
  );
  assertWarmupCurrent(execution);
  if (!summary || summary.aborted) {
    await repository.cancel(job.id);
    download.settled = true;
    return;
  }
  const unsuccessful = summary.failed + summary.sourceFailures + (summary.readiness?.missing ?? 0);
  const completed = await finishWarmupDownload(
    download,
    unsuccessful ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed',
  );
  assertWarmupCurrent(execution);
  if (input.gateway?.prune) {
    const protectedCacheKeys = await repository.protectedCacheKeys();
    assertWarmupCurrent(execution);
    await input.gateway.prune({ maxBytes: 2 * 1024 * 1024 * 1024, protectedCacheKeys }).catch(() => undefined);
  }
  assertWarmupCurrent(execution);
  execution.controller.setHostedStatus(
    execution.operation,
    unsuccessful ? 'native_warmup_partial' : 'native_warmup_ready',
  );
  execution.notify(
    `오프라인 TTS 준비 ${completed?.readyItems ?? summary.completed}/${completed?.plannedItems ?? summary.total} · ${formatBytes(completed?.byteSize ?? summary.readiness?.byteSize ?? 0)}`,
    unsuccessful ? 'warning' : 'success',
  );
}
