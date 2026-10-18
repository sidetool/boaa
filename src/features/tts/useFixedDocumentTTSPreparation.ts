import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { TTSDownloadPolicy } from '../../domain/types';
import { isAbortError } from '../../utils/async';
import type { FixedDocumentTTSPlanInput, FixedDocumentTTSTransport } from './fixed-document-tts-download';
import type { TTSCacheGateway } from './tts-cache-gateway';
import {
  assertWarmupCurrent,
  type TTSWarmupDownload,
  type TTSWarmupExecution,
  type TTSWarmupExecutionPort,
} from './tts-warmup-execution';

export interface FixedDocumentTTSPreparationInput {
  owner: object;
  ready: boolean;
  chapterId?: string;
  plan?: FixedDocumentTTSPlanInput;
  backend: { native: boolean; gateway?: TTSCacheGateway; transport?: FixedDocumentTTSTransport };
  policy: Pick<TTSDownloadPolicy, 'network' | 'charging'>;
  execution: TTSWarmupExecutionPort;
  prepareHosted: (bookId: string, chapterIds: string[], current: () => boolean) => Promise<boolean>;
  refreshDownloads: () => Promise<void>;
  notify: TTSWarmupExecution['notify'];
}
/** App-session owner: closing a panel does not end preparation; replacing its source does. */
export function useFixedDocumentTTSPreparation(input: FixedDocumentTTSPreparationInput) {
  const auxiliaryDatabase = useOptionalAppRuntime()?.readerRuntime.auxiliaryDatabase;
  const { owner, chapterId } = input;
  const bookId = input.plan?.novel.id,
    revision = input.plan?.voices.contentRevision;
  const scope = useMemo(
    () => ({
      owner,
      bookId,
      revision,
      chapterId,
      active: false,
      epoch: 0,
      pending: undefined as object | undefined,
      stop: undefined as (() => void) | undefined,
    }),
    [owner, bookId, revision, chapterId],
  );
  const latestScope = useRef(scope);
  latestScope.current = scope;
  useLayoutEffect(() => {
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
      scope.stop?.();
      scope.stop = undefined;
      scope.pending = undefined;
    };
  }, [scope]);
  const prepare = async (start: number, end: number) => {
    if (!scope.active || latestScope.current !== scope || scope.pending) return;
    if (!input.ready || !input.plan || !bookId || !revision || !chapterId) {
      input.notify('PDF 오프라인 음성을 준비할 provider를 먼저 선택하세요.', 'warning');
      return;
    }
    const attempt = {};
    const epoch = scope.epoch;
    scope.pending = attempt;
    const owned = () =>
      latestScope.current === scope && scope.active && scope.epoch === epoch && scope.pending === attempt;
    let execution: TTSWarmupExecution | undefined, download: TTSWarmupDownload | undefined;
    try {
      const operation = input.execution.beginWarmup(bookId, chapterId, 'fixed_document_warmup_loading');
      if (!operation) return;
      scope.stop = () => {
        if (input.execution.operationIsCurrent(operation)) input.execution.cancelWarmup();
        else operation.controller.abort();
      };
      const current = () => owned() && input.execution.operationIsCurrent(operation);
      execution = {
        operation,
        controller: input.execution,
        current,
        notify: (message, tone) => {
          if (current()) input.notify(message, tone);
        },
      };
      const { planFixedDocumentTTS, runFixedDocumentTTSDownload } = await import('./fixed-document-tts-download');
      assertWarmupCurrent(execution);
      const plan = await planFixedDocumentTTS(input.plan, start, end, execution);
      if (!plan) return;
      assertWarmupCurrent(execution);
      if (!input.backend.native && !(await input.prepareHosted(bookId, plan.chapterIds, current))) return;
      assertWarmupCurrent(execution);
      const downloads = await import('../../storage/tts-download-store');
      assertWarmupCurrent(execution);
      const repository = auxiliaryDatabase
        ? new (downloads.createTTSDownloadStore(auxiliaryDatabase).IndexedDbTTSDownloadRepository)()
        : new downloads.IndexedDbTTSDownloadRepository();
      const job = await repository.create({
        bookId,
        contentRevisionId: revision,
        chapterIds: plan.chapterIds,
        wholeBook: false,
        policy: input.policy,
      });
      download = { repository, job };
      assertWarmupCurrent(execution);
      await runFixedDocumentTTSDownload(plan, input.backend, download, execution);
    } catch (error) {
      const cancelled = isAbortError(error) || !owned() || execution?.operation.controller.signal.aborted;
      if (download && !download.settled)
        await (
          cancelled
            ? download.repository.cancel(download.job.id)
            : download.repository.finish(download.job.id, 'failed')
        ).catch(() => undefined);
      if (!cancelled)
        execution?.notify(
          `PDF 오프라인 음성 준비 실패: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
    } finally {
      const refresh = Boolean(execution) && owned();
      if (execution) input.execution.finishOperation(execution.operation);
      if (owned()) {
        scope.pending = undefined;
        scope.stop = undefined;
      }
      if (refresh) await input.refreshDownloads().catch(() => undefined);
    }
  };
  return { prepare };
}
