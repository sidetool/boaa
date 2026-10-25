import type { Novel } from '../../domain/types';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import { ImportCommittedRefreshError, type ImportController } from '../../services/import/import-service';
import {
  type ImportBatchCallbacks,
  type ImportBatchOutcome,
  type RunImportBatchInput,
  ImportRunCancellation,
} from './import-controller';
import { buildLocalSeriesImportFile, type LocalSeriesImportPlan } from './local-series-import';

/** Commit one release before building the next: neither upload size nor live CBZs
 * grow with the selection. A failed/cancelled release never rolls back earlier ones. */
export async function runLocalSeriesImport(
  input: Omit<RunImportBatchInput, 'files'> & {
    plan: LocalSeriesImportPlan;
    targetBookId?: string;
    signal: AbortSignal;
    replan(novel: Novel): Promise<LocalSeriesImportPlan>;
    onCommitted(bookId: string, releaseId: string, novel?: Novel, refreshError?: unknown): void;
  },
  cancellation: ImportRunCancellation,
  callbacks: ImportBatchCallbacks,
): Promise<ImportBatchOutcome> {
  cancellation.start();
  const additions = input.plan.releases.filter((release) => release.disposition === 'add');
  const outcome: ImportBatchOutcome = { completed: 0, failed: 0, skipped: input.skipped, aborted: false };
  for (const [index, release] of additions.entries()) {
    let controller: ImportController | undefined;
    let committedBookId: string | undefined;
    let canonicalRefreshed = false;
    const report = () =>
      callbacks.onBatchChange({
        total: additions.length,
        current: index + 1,
        completed: outcome.completed,
        failed: outcome.failed,
        skipped: outcome.skipped,
        currentFileName: release.originalName,
      });
    report();
    try {
      input.signal.throwIfAborted();
      if (cancellation.isRequested) throw new DOMException('Cancelled', 'AbortError');
      const targetBookId = outcome.lastImportedNovel?.id ?? input.targetBookId ?? input.plan.targetNovel?.id;
      const currentTarget = targetBookId ? await input.getNovel(targetBookId) : undefined;
      if (targetBookId && !currentTarget) throw new Error('기존 작품을 조회하지 못해 다음 회차를 추가하지 않았습니다.');
      const plan = currentTarget ? await input.replan(currentTarget) : input.plan;
      // Another completed attempt/device may already have supplied this release.
      if (plan.releases.find((entry) => entry.id === release.id)?.disposition !== 'add') {
        outcome.skipped += 1;
        continue;
      }
      callbacks.onProgress({
        jobId: 'local-series-build',
        status: 'writing',
        subphase: 'staging_chapters',
        bytesRead: 0,
        totalBytes: release.file.size,
        chaptersDetected: 1,
        paragraphsWritten: 0,
        message: `${index + 1}/${additions.length}화 준비 중`,
      });
      callbacks.onFileStarted?.(release.file);
      const file = await buildLocalSeriesImportFile(plan, input.signal, input.archivePassword, release.id);
      if (!file) throw new Error('추가할 회차를 확인하지 못했습니다.');
      const expectedSourceContentHash = plan.incrementalAppend
        ? await hashBlobInChunks(file, { shouldCancel: () => input.signal.aborted || cancellation.isRequested })
        : undefined;
      input.signal.throwIfAborted();
      controller = input.importService.importFile(
        {
          file,
          encoding: input.encoding,
          chapterSplitMode: input.chapterSplitMode,
          clientBookId: plan.targetNovel?.id,
          importMode: plan.incrementalAppend ? 'append_image_series' : undefined,
          baseActiveContentRevisionId: plan.incrementalAppend ? plan.targetNovel?.activeContentRevisionId : undefined,
          expectedSourceContentHash,
        },
        (progress) => {
          callbacks.onProgress(progress);
          callbacks.onFileProgress?.(release.file, progress);
        },
      );
      cancellation.bind(controller);
      const result = await controller.promise;
      committedBookId = result.novel.id;
      outcome.completed += 1;
      let storedNovel: Novel | undefined;
      let refreshError: unknown;
      try {
        storedNovel = await input.getNovel(committedBookId);
      } catch (error) {
        refreshError = error;
      }
      // The committed identity is sufficient for retry bookkeeping. Only a
      // canonical read may supply metadata to the owner or UI.
      input.onCommitted(committedBookId, release.id, storedNovel, refreshError);
      if (storedNovel) {
        outcome.lastImportedNovel = storedNovel;
        canonicalRefreshed = true;
      }
      if (cancellation.isRequested) throw new DOMException('Cancelled', 'AbortError');
      input.signal.throwIfAborted();
      if (!storedNovel) throw refreshError ?? new Error('저장한 작품을 아직 조회할 수 없습니다.');
      await callbacks.onFileCommitted?.(release.file, storedNovel);
    } catch (error) {
      if (error instanceof ImportCommittedRefreshError && !committedBookId) {
        committedBookId = error.bookId;
        outcome.completed += 1;
        input.onCommitted(committedBookId, release.id, undefined, error);
      }
      if (
        input.signal.aborted ||
        cancellation.isRequested ||
        (!committedBookId && error instanceof DOMException && error.name === 'AbortError')
      ) {
        outcome.aborted = true;
        callbacks.onCancelled(release.file);
      } else if (committedBookId) {
        outcome.refreshFailed = (outcome.refreshFailed ?? 0) + 1;
        callbacks.onFileRefreshFailed?.(release.file, committedBookId, error);
        // The target/release has already been recorded; a UI callback failure must
        // not discard the remaining selection or re-upload this committed release.
        if (canonicalRefreshed) continue;
      } else {
        outcome.failed += 1;
        callbacks.onFileFailed(release.file, error);
      }
      break;
    } finally {
      if (controller) cancellation.release(controller);
      report();
    }
  }
  return outcome;
}
