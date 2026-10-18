import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { useLayoutEffect, useMemo } from 'react';
import type { Chapter, Novel, TTSDownloadPolicy } from '../../domain/types';
import type { TTSWarmupSource, TTSWarmupVoicePlan } from './hosted-tts-download';
import type { HostedTTSDownloadTransport } from './hosted-tts-download-queue';
import type { NativeTTSCacheContextLoader } from './native-tts-download';
import type { BookAnalysisWorkflow } from '../ai/book-analysis-workflow-gateway';
import type { BookAITTSPreparationRunner } from '../ai/book-ai-tts-preparation-runner';
import { selectTTSWarmupChapters, type TTSWarmupScope } from './tts-warmup-plan';
import {
  assertWarmupCurrent,
  type TTSWarmupDownload,
  type TTSWarmupExecution,
  type TTSWarmupExecutionPort,
} from './tts-warmup-execution';
import { isAbortError } from '../../utils/async';

export interface TTSWarmupControllerInput {
  readonly owner: object;
  readonly novel?: Pick<Novel, 'id' | 'activeContentRevisionId'>;
  readonly currentChapter?: Chapter;
  readonly chapters: readonly Chapter[];
  readonly ready: boolean;
  readonly wholeBookReady: boolean;
  readonly native: boolean;
  readonly loadNativeContext: NativeTTSCacheContextLoader;
  readonly transport?: HostedTTSDownloadTransport;
  readonly voices: TTSWarmupVoicePlan;
  readonly source: TTSWarmupSource;
  readonly execution: TTSWarmupExecutionPort;
  readonly policy: Pick<TTSDownloadPolicy, 'network' | 'charging'>;
  readonly prepareHosted: (chapters: readonly Chapter[], current: () => boolean) => Promise<boolean>;
  readonly refreshDownloads: () => Promise<void>;
  readonly workflow?: {
    readonly value?: BookAnalysisWorkflow;
    readonly runner?: BookAITTSPreparationRunner;
    readonly adopt: (workflow: BookAnalysisWorkflow, options?: { confirmsTTSReadiness?: boolean }) => boolean;
  };
  readonly notify: (message: string, tone: 'warning' | 'success') => void;
}

/** Owns an App-session preparation lane; UI panels only invoke commands. */
export function useTTSWarmupController(input: TTSWarmupControllerInput) {
  const auxiliaryDatabase = useOptionalAppRuntime()?.readerRuntime.auxiliaryDatabase;
  const bookId = input.novel?.id,
    revision = input.novel?.activeContentRevisionId,
    chapterId = input.currentChapter?.id;
  const owner = input.owner;
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
      operation: undefined as TTSWarmupExecution['operation'] | undefined,
    }),
    [owner, bookId, revision, chapterId],
  );
  useLayoutEffect(() => {
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
      scope.stop?.();
      scope.pending = undefined;
      scope.operation = undefined;
      scope.stop = undefined;
    };
  }, [scope]);
  const warmup = async (range: TTSWarmupScope = 'current') => {
    if (!scope.active || scope.pending) return;
    if (range === 'book' && !input.wholeBookReady) {
      input.notify('주요 캐릭터 음성 샘플을 모두 승인한 뒤 책 전체 캐시를 준비할 수 있습니다.', 'warning');
      return;
    }
    if (!input.novel || !revision || !input.currentChapter || !input.ready || (!input.native && !input.transport))
      return;
    const chapters = selectTTSWarmupChapters({
      scope: range,
      chapters: input.chapters,
      currentChapter: input.currentChapter,
      nearbyChapterLimit: 3,
    });
    const attempt = {};
    const epoch = scope.epoch;
    scope.pending = attempt;
    const owned = () => scope.active && scope.epoch === epoch;
    let execution: TTSWarmupExecution | undefined;
    let download: TTSWarmupDownload | undefined;
    try {
      const operation = input.execution.beginWarmup(
        input.novel.id,
        input.currentChapter.id,
        input.native ? 'native_warmup_loading' : 'warmup_loading',
      );
      if (!operation) return;
      scope.operation = operation;
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
      if (!input.native && !(await input.prepareHosted(chapters, current))) return;
      assertWarmupCurrent(execution);
      const downloads = await import('../../storage/tts-download-store');
      assertWarmupCurrent(execution);
      const repository = auxiliaryDatabase
        ? new (downloads.createTTSDownloadStore(auxiliaryDatabase).IndexedDbTTSDownloadRepository)()
        : new downloads.IndexedDbTTSDownloadRepository();
      const job = await repository.create({
        bookId: input.novel.id,
        contentRevisionId: revision,
        chapterIds: chapters.map((chapter) => chapter.id),
        wholeBook: range === 'book',
        policy: input.policy,
      });
      download = { repository, job };
      assertWarmupCurrent(execution);
      if (input.native) {
        const { runNativeTTSDownload } = await import('./native-tts-download');
        assertWarmupCurrent(execution);
        await runNativeTTSDownload(input.loadNativeContext, chapters, range === 'book', download, execution);
      } else if (input.transport) {
        const { runHostedTTSDownload } = await import('./hosted-tts-download');
        assertWarmupCurrent(execution);
        const refreshReadiness = await runHostedTTSDownload(
          chapters,
          range === 'book',
          input.voices,
          input.source,
          input.transport,
          download,
          execution,
        );
        if (
          refreshReadiness &&
          execution.current() &&
          input.workflow?.value &&
          input.workflow.runner?.refreshCacheReadiness
        ) {
          try {
            const workflow = await input.workflow.runner.refreshCacheReadiness(
              input.workflow.value.id,
              operation.controller.signal,
            );
            if (execution.current() && workflow.novelId === input.novel.id)
              input.workflow.adopt(workflow, { confirmsTTSReadiness: true });
          } catch (error) {
            if (!isAbortError(error))
              execution.notify(
                `TTS 오디오 cache 상태 확인 실패: ${error instanceof Error ? error.message : String(error)}`,
                'warning',
              );
          }
        }
      }
    } catch (error) {
      const cancelled = isAbortError(error) || !owned() || execution?.operation.controller.signal.aborted;
      if (download && !download.settled) {
        await (
          cancelled
            ? download.repository.cancel(download.job.id)
            : download.repository.finish(download.job.id, 'failed')
        ).catch(() => undefined);
      }
      if (!cancelled && execution?.current()) {
        input.execution.setHostedStatus(execution.operation, input.native ? 'native_warmup_failed' : 'warmup_failed');
        execution.notify(
          `${input.native ? '오프라인 TTS' : '서버 TTS cache'} 준비 실패: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        );
      }
    } finally {
      if (execution) input.execution.finishOperation(execution.operation);
      if (scope.pending === attempt) {
        scope.operation = undefined;
        scope.stop = undefined;
        scope.pending = undefined;
      }
      if (execution && owned()) await input.refreshDownloads().catch(() => undefined);
    }
  };
  return { warmup };
}
