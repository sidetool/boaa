import type { Novel } from '../../domain/types';
import type { DocumentTextRepository } from '../../repositories/document-text-repository';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { clamp } from '../../utils/format';
import { buildFixedDocumentTtsQueue, selectFixedDocumentTtsSources } from '../fixed-document/text/fixed-document-tts';
import type { BuildFixedDocumentTtsWarmupRequestsInput } from '../fixed-document/text/fixed-document-tts-warmup';
import { runHostedTTSDownloadQueue, type HostedTTSDownloadTransport } from './hosted-tts-download-queue';
import type { TTSCacheGateway } from './tts-cache-gateway';
import {
  assertWarmupCurrent,
  downloadObserver,
  finishWarmupDownload,
  type TTSWarmupDownload,
  type TTSWarmupExecution,
} from './tts-warmup-execution';

export interface FixedDocumentTTSPlanInput {
  novel: Pick<Novel, 'id' | 'language'>;
  repository: Pick<DocumentTextRepository, 'listReadyRevisions' | 'getBlocks'>;
  voices: Omit<BuildFixedDocumentTtsWarmupRequestsInput, 'queue'>;
  speech: Pick<Parameters<typeof buildFixedDocumentTtsQueue>[0], 'rate' | 'rules'>;
}
/** Snapshot source provenance and speech settings once for the requested bounded range. */
export async function planFixedDocumentTTS(
  input: FixedDocumentTTSPlanInput,
  start: number,
  end: number,
  execution: TTSWarmupExecution,
) {
  const profile = input.voices.voiceProfiles.find((value) => value.role === 'narrator' && !value.characterId);
  if (!profile) {
    execution.notify('PDF 오프라인 준비에 사용할 내레이터 음성을 먼저 지정하세요.', 'warning');
    return;
  }
  const first = clamp(Math.min(start, end), 0, input.voices.chapters.length - 1);
  const last = clamp(Math.max(start, end), first, Math.min(input.voices.chapters.length - 1, first + 49));
  const revisions = await input.repository.listReadyRevisions(input.novel.id);
  assertWarmupCurrent(execution);
  const loaded = await Promise.all(
    revisions
      .filter((revision) => revision.pageIndex >= first && revision.pageIndex <= last)
      .map(async (revision) => ({ revision, blocks: await input.repository.getBlocks(revision.id) })),
  );
  assertWarmupCurrent(execution);
  const { sources, skippedOcr } = selectFixedDocumentTtsSources(loaded);
  if (skippedOcr.length)
    execution.notify(
      `OCR 신뢰도가 낮은 ${skippedOcr.length}페이지는 오프라인 음성 준비에서 건너뜁니다. 해당 페이지를 다시 OCR해 주세요.`,
      'warning',
    );
  const queue = buildFixedDocumentTtsQueue({
    ...input.speech,
    blocks: sources.flatMap((source) => source.blocks),
    language: input.novel.language,
    voiceProfile: profile,
  });
  const { buildFixedDocumentTtsWarmupRequests } = await import('../fixed-document/text/fixed-document-tts-warmup');
  assertWarmupCurrent(execution);
  const requests = buildFixedDocumentTtsWarmupRequests({ ...input.voices, queue });
  if (!requests.length) {
    execution.notify('선택 범위에 준비된 PDF 본문이 없습니다. 텍스트 준비 또는 OCR을 먼저 실행하세요.', 'warning');
    return;
  }
  return {
    requests,
    sources,
    chapters: [...input.voices.chapters].sort((a, b) => a.index - b.index),
    chapterIds: [...new Set(requests.map((request) => request.chapterId))],
  };
}
export type FixedDocumentTTSPlan = NonNullable<Awaited<ReturnType<typeof planFixedDocumentTTS>>>;
export type FixedDocumentTTSTransport = HostedTTSDownloadTransport & {
  client: HostedTTSDownloadTransport['client'] & Pick<RemoteApiClient, 'saveDocumentTextPage'>;
};

/** Execute a prepared source snapshot through the existing persistent download runners. */
export async function runFixedDocumentTTSDownload(
  plan: FixedDocumentTTSPlan,
  backend: { native: boolean; gateway?: TTSCacheGateway; transport?: FixedDocumentTTSTransport },
  download: TTSWarmupDownload,
  execution: TTSWarmupExecution,
) {
  assertWarmupCurrent(execution);
  const signal = execution.operation.controller.signal;
  let summary;
  let extraFailures = 0;
  if (backend.native) {
    if (!backend.gateway) throw new Error('데스크톱 TTS cache gateway를 사용할 수 없습니다.');
    const { runNativeTTSWarmup } = await import('./native-tts-warmup-runner');
    assertWarmupCurrent(execution);
    const grouped = new Map<string, typeof plan.requests>();
    for (const request of plan.requests) {
      const bucket = grouped.get(request.chapterId);
      if (bucket) bucket.push(request);
      else grouped.set(request.chapterId, [request]);
    }
    const result = await runNativeTTSWarmup({
      novelId: download.job.bookId,
      contentRevision: download.job.contentRevisionId,
      chapters: plan.chapters.filter((chapter) => grouped.has(chapter.id)),
      signal,
      gateway: backend.gateway,
      loadChapterSource: async (chapter) => {
        assertWarmupCurrent(execution);
        const requests = grouped.get(chapter.id) ?? [];
        return {
          chapterId: chapter.id,
          chapterTextHash: chapter.textHash,
          segments: [],
          paragraphs: requests.map((request) => ({
            id: request.paragraphId,
            novelId: download.job.bookId,
            chapterId: chapter.id,
            index: request.paragraphIndex,
            text: request.text,
            startOffsetInChapter: 0,
            endOffsetInChapter: request.text.length,
            textHash: request.request.inputTextHash,
          })),
        };
      },
      buildRequests: (sources) => sources.flatMap((source) => grouped.get(source.chapterId) ?? []),
      retryLimit: download.job.policy.retryLimit,
      recoveryPolicy: download.job.policy,
      observer: downloadObserver(download),
      onStatus: (status) => {
        if (execution.current()) execution.controller.setHostedStatus(execution.operation, status);
      },
    });
    summary = result;
    extraFailures = result.sourceFailures + (result.readiness?.missing ?? 0);
  } else if (backend.transport) {
    for (const source of plan.sources) {
      assertWarmupCurrent(execution);
      await backend.transport.client.saveDocumentTextPage(download.job.bookId, source.revision, source.blocks, signal);
    }
    assertWarmupCurrent(execution);
    summary = await runHostedTTSDownloadQueue(plan.requests, backend.transport, download, execution);
  } else throw new Error('PDF TTS cache gateway를 사용할 수 없습니다.');
  assertWarmupCurrent(execution);
  if (summary.aborted) throw new DOMException('PDF TTS cancelled', 'AbortError');
  const failures = summary.failed + extraFailures;
  const completed = await finishWarmupDownload(
    download,
    failures ? (summary.completed > 0 ? 'partial' : 'failed') : 'completed',
  );
  execution.notify(
    `PDF 오프라인 음성 ${completed?.readyItems ?? summary.completed}/${completed?.plannedItems ?? summary.total}개 준비`,
    failures ? 'warning' : 'success',
  );
}
