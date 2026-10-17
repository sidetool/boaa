import type { Chapter } from '../../domain/types';
import type {
  BuildHostedTTSBulkWarmupRequestsInput,
  HostedTTSWarmupChapterSource,
} from '../../providers/hosted-tts-warmup';
import type { TtsVoiceBindingV1 } from '../../providers/voice-casting';
import { loadTTSWarmupChapterSource } from './tts-warmup-plan';
import { runHostedTTSDownloadQueue, type HostedTTSDownloadTransport } from './hosted-tts-download-queue';
import {
  assertWarmupCurrent,
  finishWarmupDownload,
  type TTSWarmupDownload,
  type TTSWarmupExecution,
} from './tts-warmup-execution';
import { abortableDelay, isAbortError } from '../../utils/async';

export type TTSWarmupVoicePlan = Omit<BuildHostedTTSBulkWarmupRequestsInput, 'chapters' | 'maxRequests'>;
export interface TTSWarmupSource extends Omit<
  Parameters<typeof loadTTSWarmupChapterSource>[0],
  'chapter' | 'signal' | 'maxCandidateParagraphs'
> {
  readonly loadVoiceBindings: (chapterId: string) => Promise<readonly TtsVoiceBindingV1[]>;
}
export async function runHostedTTSDownload(
  chapters: Chapter[],
  wholeBook: boolean,
  voices: TTSWarmupVoicePlan,
  source: TTSWarmupSource,
  transport: HostedTTSDownloadTransport,
  download: TTSWarmupDownload,
  execution: TTSWarmupExecution,
): Promise<boolean> {
  const [
    {
      buildHostedTTSBulkWarmupRequests,
      DEFAULT_HOSTED_TTS_WARMUP_LIMIT,
      DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT,
    },
    { runHostedTTSBackgroundWarmup },
  ] = await Promise.all([
    import('../../providers/hosted-tts-warmup'),
    import('../../providers/hosted-tts-background-warmup-runner'),
  ]);
  assertWarmupCurrent(execution);
  const signal = execution.operation.controller.signal;
  const load = async (chapter: Chapter, limit: number): Promise<HostedTTSWarmupChapterSource | undefined> => {
    assertWarmupCurrent(execution);
    const [body, voiceBindings] = await Promise.all([
      loadTTSWarmupChapterSource({ ...source, chapter, maxCandidateParagraphs: limit, signal }),
      source.loadVoiceBindings(chapter.id),
    ]);
    assertWarmupCurrent(execution);
    return body ? { ...body, voiceBindings } : undefined;
  };
  const build = (sources: HostedTTSWarmupChapterSource[], maxRequests: number) =>
    buildHostedTTSBulkWarmupRequests({ ...voices, chapters: sources, maxRequests });
  const runQueue = (requests: ReturnType<typeof build>) =>
    runHostedTTSDownloadQueue(requests, transport, download, execution);
  let summary;
  let sourceFailures = 0;
  if (wholeBook) {
    summary = await runHostedTTSBackgroundWarmup({
      chapters,
      signal,
      chapterBatchSize: DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT,
      loadChapterSource: (chapter) => load(chapter, Number.POSITIVE_INFINITY),
      buildRequests: (sources) => build(sources, Number.POSITIVE_INFINITY),
      runQueue,
      yieldBetweenBatches: () => abortableDelay(0, signal),
      onStatus: (status) => {
        if (execution.current()) execution.controller.setHostedStatus(execution.operation, status);
      },
      isAbortError,
    });
    sourceFailures = summary.sourceFailures;
  } else {
    const sources: HostedTTSWarmupChapterSource[] = [];
    for (const chapter of chapters) {
      const loaded = await load(chapter, DEFAULT_HOSTED_TTS_WARMUP_LIMIT);
      if (loaded?.paragraphs.length) sources.push(loaded);
    }
    const requests = build(sources, DEFAULT_HOSTED_TTS_WARMUP_LIMIT);
    summary = await runQueue(requests);
  }
  assertWarmupCurrent(execution);
  if (summary.aborted) {
    await download.repository.cancel(download.job.id);
    download.settled = true;
    return false;
  }
  if (summary.total === 0) {
    await finishWarmupDownload(download, 'completed');
    assertWarmupCurrent(execution);
    execution.controller.setHostedStatus(execution.operation, 'warmup_empty');
    execution.notify('준비할 서버 TTS cache 대상이 없습니다.', 'warning');
    return false;
  }
  const failed = summary.failed + sourceFailures;
  await finishWarmupDownload(download, failed ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed');
  assertWarmupCurrent(execution);
  execution.controller.setHostedStatus(execution.operation, failed ? 'warmup_partial' : 'warmup_ready');
  execution.notify(
    wholeBook && 'chapters' in summary
      ? `서버 TTS 전체 cache 준비 완료: ${summary.completed}/${summary.total}개 · ${summary.chapters}화 · hit ${summary.cacheHits} · job ${summary.jobs}`
      : `서버 TTS cache 준비 완료: ${summary.total - failed}/${summary.total}개 · hit ${summary.cacheHits} · job ${summary.jobs}`,
    failed ? 'warning' : 'success',
  );
  return wholeBook;
}
