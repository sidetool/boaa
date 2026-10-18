import { isLocalArchiveSeriesContentType } from '@boaa/document-series-core/local-archive-series';
import { chunked, iterateImportParagraphPageBatchesAsync } from './import/paragraph-pages.js';
import { AssetWriteBatch } from './import/asset-write-batch.js';
import { rekeyParsedNovelImport } from './import/rekey.js';
import { insertChapterBatch, insertParagraphPageBatch, replaceParsedBookContent } from './import/stage-content.js';
import { readUploadFile, arrayBufferFromBuffer } from './import/source-reader.js';
import {
  claimImportExecution,
  assertImportExecutionActive,
  updateImportJobProgress,
  startImportHeartbeat,
  ImportExecutionStoppedError,
  SINGLE_IMPORT_ATTEMPT,
  type ImportExecutionAttempt,
  type Queryable,
} from './import/execution.js';
import { LOCAL_ARCHIVE_SERIES_TYPE } from '@boaa/document-series-core';
import {
  loadLocalAppendBase,
  localAppendAlreadyPresent,
  promoteLocalComicSection,
  localSourceAsset,
  localAppendSource,
  offsetLocalAppend,
  type LocalAppendBase,
} from './local-archive-append.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import {
  copyStoredObject,
  createS3Client,
  getObjectBuffer,
  inspectStoredObject,
  putRawBookObject,
} from './object-storage.js';
import { parseNovelFileForImport } from '@boaa/text-core/parser';
import { materializeStreamingEpubImport } from '@boaa/epub-core';
import { hasDocumentSeriesManifest, materializeDocumentSeriesArchive } from '@boaa/document-series-core';
import {
  materializePdfImport,
  materializeStreamingImageArchiveImport,
  openImageArchiveStream,
} from '@boaa/fixed-document-core';
import type { ParsedNovelImport, ParsedNovelImportAsset } from '@boaa/contracts';
import { integrityHash, persistentId128 } from '@boaa/text-core/hash';
import { syncPayloadIntegrityHash } from '@boaa/text-core/identity/sync';
import { assertLargeArchiveSupported, MAX_LOCAL_ARCHIVE_EXPANDED_BYTES } from './local-archive-policy.js';
import { removeUploadDirectory } from './upload-cleanup.js';
import {
  finalizeBookReplacement,
  prepareBookReplacement,
  restoreExactAnchoredReaderState,
} from './book-revision/service.js';
import {
  enqueueObjectDeletions,
  releaseObjectDeletionReservations,
  reserveObjectDeletions,
} from './object-delete-outbox.js';
import {
  COMIC_SOURCE_CONTENT_TYPE,
  comicPageAssetId,
  materializeComicSource,
  planComicSourceAppend,
  unpackComicSource,
  type ComicSourceAppendPlan,
} from '@boaa/fixed-document-core/comic-source';
import { loadImportPageReuse } from './import-page-reuse.js';
import { retainComicAssets } from './comic-source-retention.js';
import { ImportMeasurements } from './import-measurements.js';
import type { StructuredLogger } from '../observability/logger.js';
import { createImportProgressUpdateThrottle } from './import-progress-throttle.js';
import { assertImportExpectedBase, parseImportExpectedBase } from './import-expected-base.js';

// Preserve the service entry point used by workers, imports and existing callers.
export {
  buildParagraphPages,
  iterateChapterParagraphPages,
  iterateParagraphPageBatches,
  iterateImportParagraphPageBatches,
  iterateImportParagraphPageBatchesAsync,
} from './import/paragraph-pages.js';
export { rekeyParsedNovel, rekeyParsedNovelImport } from './import/rekey.js';
export { insertChapterBatch, insertParagraphPageBatch, replaceParsedBookContent } from './import/stage-content.js';
export { arrayBufferFromBuffer } from './import/source-reader.js';
export type { ImportExecutionAttempt } from './import/execution.js';

const SERVER_IMPORT_CHAPTER_BATCH_SIZE = 100;
const SERVER_IMPORT_PAGE_BATCH_SIZE = 25;
const SERVER_IMPORT_EAGER_ASSET_CONCURRENCY = 4;
const POSITIVE_SIGNED_INTEGER_MODULUS = 0x80000000;

export function normalizeCoverSeedForPersistence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return (
    ((integer % POSITIVE_SIGNED_INTEGER_MODULUS) + POSITIVE_SIGNED_INTEGER_MODULUS) % POSITIVE_SIGNED_INTEGER_MODULUS
  );
}

interface ImageSeriesAppendBaseRow {
  readonly id: string;
  readonly format: string;
  readonly active_content_revision_id: string;
  readonly source_file_name: string;
  readonly storage_key: string;
  readonly content_type: string;
  readonly total_chapters: number | string;
  readonly size_bytes?: number | string;
  readonly raw_text_hash: string;
}

async function lockImageSeriesAppend(pool: pg.Pool, bookId: string): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 7319))', [bookId]);
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function unlockImageSeriesAppend(client: pg.PoolClient, bookId: string): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 7319))', [bookId]);
  } finally {
    client.release();
  }
}

async function loadImageSeriesAppendBase(
  queryable: Queryable,
  userId: string,
  bookId: string,
): Promise<ImageSeriesAppendBaseRow> {
  const result = await queryable.query<ImageSeriesAppendBaseRow>(
    `select book.id, book.format, book.active_content_revision_id, book.source_file_name,
            object.storage_key, object.content_type, object.raw_text_hash, object.size_bytes, book.total_chapters
       from library_books book
       join book_objects object on object.id = book.object_id
      where book.id = $1 and book.user_id = $2 and book.deleted_at is null`,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('회차를 추가할 기존 만화 작품이나 원본을 찾지 못했습니다.');
  if (isLocalArchiveSeriesContentType(row.content_type)) throw new Error('이 합본은 원본 파일로 회차를 추가해 주세요.');
  if (row.format !== 'image_archive') throw new Error('만화 작품에만 회차 delta를 추가할 수 있습니다.');
  if (!row.active_content_revision_id) throw new Error('기존 만화 작품의 활성 본문 revision을 찾지 못했습니다.');
  return row;
}

async function finalizeNoopImageSeriesAppend(
  client: pg.PoolClient,
  input: {
    readonly uploadId: string;
    readonly jobId: string;
    readonly bookId: string;
    readonly userId: string;
    readonly expectedContentRevisionId: string;
    readonly bytesRead: number;
    readonly totalBytes: number;
    readonly totalChapters: number;
    readonly attempt: ImportExecutionAttempt;
  },
): Promise<void> {
  await client.query('begin');
  try {
    const current = await client.query<{ active_content_revision_id: string }>(
      `select active_content_revision_id from library_books
        where id = $1 and user_id = $2 and active_content_revision_id = $3
        for update`,
      [input.bookId, input.userId, input.expectedContentRevisionId],
    );
    if (!current.rows[0]) throw new Error('image_series_append_base_changed');
    const activatedUpload = await client.query(
      `update upload_sessions set status = 'imported', updated_at = now()
        where id = $1 and status = 'queued'
          and exists (
            select 1 from import_jobs
             where id = $2 and status = 'processing' and cancel_requested_at is null
               ${input.attempt.executionId ? 'and active_queue_job_id = $3' : ''}
          )
        returning id`,
      input.attempt.executionId
        ? [input.uploadId, input.jobId, input.attempt.executionId]
        : [input.uploadId, input.jobId],
    );
    if (activatedUpload.rowCount === 0) throw new ImportExecutionStoppedError('cancelled');
    await client.query('delete from upload_chunks where upload_id = $1', [input.uploadId]);
    const finalized = await updateImportJobProgress(
      client,
      input.jobId,
      {
        status: 'done',
        stage: 'ready',
        bytesRead: input.bytesRead,
        totalBytes: input.totalBytes,
        chaptersDetected: input.totalChapters,
        paragraphsWritten: 0,
        message: '이미 반영된 회차입니다.',
        bookId: input.bookId,
        errorMessage: null,
      },
      input.attempt.executionId,
    );
    if (input.attempt.executionId && !finalized) throw new ImportExecutionStoppedError('cancelled');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function processImportJob(
  pool: pg.Pool,
  config: ServerConfig,
  jobId: string,
  uploadId: string,
  attempt: ImportExecutionAttempt = SINGLE_IMPORT_ATTEMPT,
  logger?: Pick<StructuredLogger, 'info'>,
): Promise<void> {
  // The queue supplies identifiers, never authority. Verify their persisted relationship before claiming work.
  const ownership = await pool.query<{ user_id: string; legacy_owner: boolean }>(
    `select j.user_id, exists(select 1 from self_host_accounts owner where owner.user_id=j.user_id and owner.bootstrap_owner_key=1) as legacy_owner from import_jobs j join upload_sessions u on u.id=j.upload_id and u.user_id=j.user_id
      where j.id=$1 and j.upload_id=$2
        and not exists (select 1 from self_host_accounts a where a.user_id=j.user_id and a.status<>'active')`,
    [jobId, uploadId],
  );
  if (!ownership.rows[0]) throw new Error('import_job_upload_mismatch');
  config = Object.freeze({ ...config, defaultUserId: ownership.rows[0].user_id });
  if (!(await claimImportExecution(pool, jobId, attempt.executionId))) return;
  const measurements = new ImportMeasurements(logger, jobId);
  if (!attempt.executionId) {
    await updateImportJobProgress(pool, jobId, {
      status: 'processing',
      stage: 'reading',
      message: '파일 준비 중',
      errorMessage: null,
    });
  }

  const importAbort = new AbortController();
  const stopHeartbeat = startImportHeartbeat(pool, jobId, importAbort, attempt.executionId);

  const uploadedObjectKeys: string[] = [];
  let importCommitted = false;
  let appendNoop = false;
  let disposeUploadFile: (() => Promise<void>) | undefined;
  let appendLockClient: pg.PoolClient | undefined;
  let appendLockBookId: string | undefined;
  try {
    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    const upload = await readUploadFile(pool, config, uploadId, importAbort.signal, async (bytes, total) => {
      const active = await updateImportJobProgress(
        pool,
        jobId,
        {
          stage: 'reading',
          bytesRead: bytes,
          totalBytes: total,
          message: `파일 준비 ${Math.floor((bytes / total) * 100)}%`,
        },
        attempt.executionId,
      );
      if (attempt.executionId && !active) throw new ImportExecutionStoppedError('cancelled');
    });
    disposeUploadFile = upload.dispose;
    const { session } = upload;
    let sourceBlob = upload.blob;
    await assertLargeArchiveSupported(sourceBlob, session.file_name, config.maxUploadBytes, importAbort.signal);
    const expectedBase = parseImportExpectedBase(session.expected_base);
    if (
      expectedBase &&
      (!session.client_book_id ||
        session.import_mode === 'append_image_series' ||
        session.import_mode === 'append_local_archive')
    ) {
      throw new Error('invalid_import_expected_base');
    }
    const bytesRead = sourceBlob.size;
    const totalBytes = Number(session.size_bytes);
    measurements.counts.uploadBytes = bytesRead;
    const uploadedSourceContentHash = upload.contentHash;
    if (session.source_content_hash && uploadedSourceContentHash !== session.source_content_hash) {
      throw new Error('Uploaded source bytes do not match sourceContentHash');
    }
    const suppliedBookId = session.client_book_id?.trim();
    const existingTarget = suppliedBookId
      ? await pool.query<{ user_id: string }>('select user_id from library_books where id=$1', [suppliedBookId])
      : undefined;
    if (existingTarget?.rows[0] && existingTarget.rows[0].user_id !== session.user_id)
      throw new Error('import_target_not_found');
    if (!existingTarget?.rows[0]) {
      if (session.import_mode && session.import_mode !== 'replace_book') throw new Error('import_target_not_found');
      // Supply the owner identity before any materializer creates chapters, pages, assets or nested references.
      if (!ownership.rows[0].legacy_owner) {
        session.client_book_id = persistentId128('hosted_book', [
          session.user_id,
          suppliedBookId || uploadedSourceContentHash,
        ]);
      }
    }
    let sourceContentHash = uploadedSourceContentHash;
    let canonicalFileName = session.file_name;
    let canonicalContentType = session.content_type;
    let appendBaseContentRevisionId: string | undefined;
    let appendNoopTotalChapters = 0;
    const importMode = session.import_mode ?? 'replace_book';
    const incrementalImageSeriesAppend = importMode === 'append_image_series';
    const localArchiveAppend = importMode === 'append_local_archive';
    let localAppendBase: LocalAppendBase | undefined;
    if (localArchiveAppend) {
      const bookId = session.client_book_id;
      if (!bookId) throw new Error('회차를 추가할 작품이 없습니다.');
      appendLockBookId = bookId;
      appendLockClient = await lockImageSeriesAppend(pool, bookId);
      localAppendBase = await loadLocalAppendBase(appendLockClient, session.user_id, bookId, session.file_name);
      appendBaseContentRevisionId = localAppendBase.active_content_revision_id;
      if (localAppendAlreadyPresent(localAppendBase, uploadedSourceContentHash)) {
        appendNoop = true;
        await finalizeNoopImageSeriesAppend(appendLockClient, {
          uploadId,
          jobId,
          bookId,
          userId: session.user_id,
          expectedContentRevisionId: appendBaseContentRevisionId,
          bytesRead,
          totalBytes,
          totalChapters: Number(localAppendBase.total_chapters),
          attempt,
        });
        importCommitted = true;
        await removeUploadDirectory(config, uploadId);
        return;
      }
      if (session.base_active_content_revision_id !== appendBaseContentRevisionId)
        throw new Error('작품이 다른 작업에서 변경되었습니다. 목록을 갱신한 뒤 다시 추가해 주세요.');
      if (
        localAppendBase.assets.some(
          (a) => a.kind === 'source_part' && a.fileName.normalize('NFKC') === session.file_name.normalize('NFKC'),
        ) ||
        (!isLocalArchiveSeriesContentType(localAppendBase.content_type) &&
          localAppendBase.source_file_name.normalize('NFKC') === session.file_name.normalize('NFKC'))
      )
        throw new Error('같은 이름의 다른 원본이 있습니다. 파일 이름을 구분한 뒤 추가해 주세요.');
    }
    let comicPlan: ComicSourceAppendPlan | undefined;
    let preparedComic: ParsedNovelImport | undefined;
    const comicPagePartsToRead = new Map<string, Blob>();
    const comicPageIdsToRead = new Set<string>();
    measurements.counts.incrementalAppend = incrementalImageSeriesAppend || localArchiveAppend;
    if (incrementalImageSeriesAppend) {
      const bookId = session.client_book_id?.trim();
      if (!bookId) throw new Error('회차 delta에 대상 만화 작품 ID가 없습니다.');
      appendLockBookId = bookId;
      measurements.start('append_lock');
      appendLockClient = await lockImageSeriesAppend(pool, bookId);
      measurements.start('base_read_merge');
      await assertImportExecutionActive(pool, jobId, attempt.executionId);
      const appendBase = await loadImageSeriesAppendBase(appendLockClient, session.user_id, bookId);
      appendBaseContentRevisionId = appendBase.active_content_revision_id;
      appendNoopTotalChapters = Number(appendBase.total_chapters);
      const s3Client = createS3Client(config);
      if (Number(appendBase.size_bytes ?? 0) > config.maxUploadBytes)
        throw new Error('대용량 로컬 만화에 회차를 추가하는 기능은 아직 지원하지 않습니다.');
      const existingObject = await getObjectBuffer(s3Client, config, appendBase.storage_key);
      measurements.counts.baseBytes = existingObject.body.length;
      const existingAssets = await appendLockClient.query<{
        id: string;
        kind: string;
        content_hash: string;
        page_index: number | null;
      }>(
        "select id, kind, content_hash, page_index from book_assets where user_id = $1 and book_id = $2 and status = 'active' and kind in ('document_page', 'source_part')",
        [session.user_id, bookId],
      );
      const merged = await planComicSourceAppend({
        existingSource: new Blob([arrayBufferFromBuffer(existingObject.body)], {
          type: appendBase.content_type || 'application/vnd.comicbook+zip',
        }),
        existingSourceHash: appendBase.raw_text_hash,
        delta: sourceBlob,
        deltaHash: uploadedSourceContentHash,
        bookId,
        signal: importAbort.signal,
        existingAssets: existingAssets.rows.map((asset) => ({
          ...asset,
          contentHash: asset.content_hash,
          pageIndex: asset.page_index ?? undefined,
        })),
      });
      if (
        session.base_active_content_revision_id !== appendBaseContentRevisionId &&
        merged.replacedSectionIds.length > 0
      ) {
        throw new Error('image_series_append_base_changed');
      }
      if (merged.changedSectionIds.length === 0) {
        appendNoop = true;
        await updateImportJobProgress(pool, jobId, { message: '마무리 중' }, attempt.executionId);
        measurements.start('commit_database');
        await finalizeNoopImageSeriesAppend(appendLockClient, {
          uploadId,
          jobId,
          bookId,
          userId: session.user_id,
          expectedContentRevisionId: appendBaseContentRevisionId,
          bytesRead,
          totalBytes,
          totalChapters: appendNoopTotalChapters,
          attempt,
        });
        importCommitted = true;
        measurements.start('cleanup');
        await removeUploadDirectory(config, uploadId);
        return;
      }
      comicPlan = merged;
      canonicalFileName = appendBase.source_file_name || session.file_name;
      for (const [hash, blob] of merged.newParts)
        if (hash !== appendBase.raw_text_hash) comicPagePartsToRead.set(hash, blob);
      merged.manifest.sourcePages
        .filter((page) => comicPagePartsToRead.has(page.partHash))
        .forEach((page) => comicPageIdsToRead.add(comicPageAssetId(bookId, page)));
      preparedComic = await materializeComicSource({
        manifest: merged.manifest,
        sourceContentHash: merged.sourceContentHash,
        fileName: canonicalFileName,
        bookId,
        // First conversion stores the already-read legacy CBZ as an attempt-owned part.
        // Its shared book_objects key can be replaced and collected by another import.
        // Later appends only contain the new parts; existing pages still stay untouched.
        partsToStore: merged.newParts,
        pagePartsToRead: comicPagePartsToRead,
        pageAssetIdsToRead: comicPageIdsToRead,
        pageAssetIds: merged.pageAssetIds,
        signal: importAbort.signal,
      });
      sourceBlob = merged.source;
      sourceContentHash = merged.sourceContentHash;
      canonicalContentType = COMIC_SOURCE_CONTENT_TYPE;
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'processing',
          stage: 'decoding',
          bytesRead,
          totalBytes,
          message: `${merged.changedSectionIds.length.toLocaleString()}개 회차를 기존 작품에 반영하는 중입니다.`,
        },
        attempt.executionId,
      );
    }
    await updateImportJobProgress(
      pool,
      jobId,
      {
        status: 'processing',
        stage: 'decoding',
        bytesRead,
        totalBytes,
        message: '내용 분석 중',
      },
      attempt.executionId,
    );
    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    measurements.start('parse_archive');
    const s3Client = createS3Client(config);
    const storedAssets: Array<Omit<ParsedNovelImportAsset, 'bytes'> & { byteLength: number; storageKey: string }> = [];
    const shouldReportEpubAssets = createImportProgressUpdateThrottle();
    let parsed: ParsedNovelImport;
    const comicPackage =
      !preparedComic && /\.(zip|cbz)$/i.test(canonicalFileName) ? await unpackComicSource(sourceBlob) : undefined;
    if (comicPackage) {
      sourceBlob = comicPackage.source;
      sourceContentHash = integrityHash(new Uint8Array(await sourceBlob.arrayBuffer()));
      canonicalContentType = COMIC_SOURCE_CONTENT_TYPE;
      preparedComic = await materializeComicSource({
        manifest: comicPackage.manifest,
        sourceContentHash,
        fileName: canonicalFileName,
        bookId: session.client_book_id?.trim() || persistentId128('comic_book', [sourceContentHash]),
        partsToStore: comicPackage.parts,
        pagePartsToRead: comicPackage.parts,
        signal: importAbort.signal,
      });
    }
    if (localArchiveAppend && (preparedComic || comicPackage))
      throw new Error('일반 EPUB 또는 ZIP·CBZ 원본을 선택해 주세요.');
    if (preparedComic) {
      parsed = preparedComic;
    } else if (/\.zip$/i.test(canonicalFileName) && (await hasDocumentSeriesManifest(sourceBlob))) {
      if (localArchiveAppend) throw new Error('일반 EPUB 또는 ZIP·CBZ 원본을 선택해 주세요.');
      parsed = await materializeDocumentSeriesArchive(sourceBlob, {
        fileName: canonicalFileName,
        clientBookId: session.client_book_id ?? undefined,
        sourceContentHash,
      });
    } else if (/\.epub$/i.test(canonicalFileName)) {
      let totalAssets: number | undefined;
      let reusedAssets = 0;
      const assets = new AssetWriteBatch<{ asset: ParsedNovelImportAsset; key: string }>({
        maxCount: SERVER_IMPORT_EAGER_ASSET_CONCURRENCY,
        maxBytes: 16 * 1024 * 1024,
        byteLength: ({ asset }) => asset.bytes.byteLength,
        beforeWrite: async (batch) => {
          await assertImportExecutionActive(pool, jobId, attempt.executionId);
          await reserveObjectDeletions(
            pool,
            batch.map(({ key }) => key),
            'import_asset_staging',
          );
        },
        write: async ({ asset, key }) => {
          await putRawBookObject(
            s3Client,
            config,
            key,
            Buffer.from(asset.bytes),
            asset.contentType,
            importAbort.signal,
          );
          uploadedObjectKeys.push(key);
          const { bytes, ...metadata } = asset;
          storedAssets.push({ ...metadata, byteLength: bytes.byteLength, storageKey: key });
        },
        afterWrite: async () => {
          if (shouldReportEpubAssets())
            await updateImportJobProgress(
              pool,
              jobId,
              {
                stage: 'writing',
                message: `이미지 저장 ${(storedAssets.length + reusedAssets).toLocaleString()}개`,
                progressUnit: 'images',
                progressCompleted: storedAssets.length + reusedAssets,
                progressTotal: totalAssets,
              },
              attempt.executionId,
            );
        },
      });
      parsed = await materializeStreamingEpubImport(sourceBlob, {
        fileName: canonicalFileName,
        sourceContentHash,
        clientBookId: session.client_book_id ?? undefined,
        signal: importAbort.signal,
        maxExpandedBytes: MAX_LOCAL_ARCHIVE_EXPANDED_BYTES,
        onAsset: async (asset, progress) => {
          totalAssets = progress.totalAssets;
          if (localAppendBase?.assets.some((existing) => existing.id === asset.id)) {
            reusedAssets += 1;
            return;
          }
          const key = `${session.user_id}/${asset.bookId}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`;
          await assets.add({ asset, key });
        },
      });
      // The parser may finish with fewer than four assets. Persist these before activation.
      await assets.flush();
    } else if (/\.pdf$/i.test(canonicalFileName)) {
      parsed = await materializePdfImport({
        fileName: canonicalFileName,
        sourceBytes: new Uint8Array(await sourceBlob.arrayBuffer()),
        clientBookId: session.client_book_id ?? undefined,
      });
    } else if (/\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(canonicalFileName)) {
      const document = await openImageArchiveStream(sourceBlob, {
        maxExpandedBytes: MAX_LOCAL_ARCHIVE_EXPANDED_BYTES,
        fileName: canonicalFileName,
        signal: importAbort.signal,
      });
      parsed = materializeStreamingImageArchiveImport({
        fileName: canonicalFileName,
        sourceContentHash,
        document,
        clientBookId: session.client_book_id ?? undefined,
      });
    } else {
      parsed = rekeyParsedNovelImport(
        await parseNovelFileForImport(canonicalFileName, await sourceBlob.arrayBuffer(), session.encoding, {
          chapterSplitMode: session.chapter_split_mode ?? 'auto',
        }),
        session.client_book_id,
      );
    }
    if (localAppendBase) {
      measurements.start('preserve_source_parts');
      if (parsed.novel.format !== localAppendBase.format) throw new Error('회차 형식이 기존 작품과 다릅니다.');
      if (
        parsed.novel.format === 'image_archive' &&
        Number(localAppendBase.total_chapters) + parsed.chapters.length > 20_000
      )
        throw new Error('작품당 20,000페이지까지 추가할 수 있습니다.');
      const original = sourceBlob;
      const newIds = new Set(storedAssets.map((asset) => asset.id));
      storedAssets.push(...localAppendBase.assets.filter((asset) => !newIds.has(asset.id)));
      const reusedPages = localAppendBase.assets.filter(
        (asset) => asset.kind === 'document_page' && !newIds.has(asset.id),
      );
      measurements.counts.reusedPages = reusedPages.length;
      measurements.counts.reusedPageBytes = reusedPages.reduce((bytes, asset) => bytes + asset.byteLength, 0);
      // Protect the first original from shared book_objects cleanup. Later appends never copy old parts.
      if (
        !isLocalArchiveSeriesContentType(localAppendBase.content_type) &&
        !localAppendBase.assets.some((a) => a.kind === 'source_part')
      ) {
        await updateImportJobProgress(pool, jobId, { message: '기존 원본 보관 중' }, attempt.executionId);
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const part = localSourceAsset(
          localAppendBase.id,
          localAppendBase.raw_text_hash,
          localAppendBase.source_file_name,
          localAppendBase.content_type,
          Number(localAppendBase.size_bytes),
          0,
        );
        const key = `${session.user_id}/${part.bookId}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${part.id}/original`;
        await reserveObjectDeletions(pool, [key], 'import_source_part_staging');
        await copyStoredObject(s3Client, config, localAppendBase.storage_key, key, importAbort.signal);
        uploadedObjectKeys.push(key);
        storedAssets.push({ ...part, storageKey: key });
      }
      await updateImportJobProgress(pool, jobId, { message: '새 회차 원본 저장 중' }, attempt.executionId);
      await assertImportExecutionActive(pool, jobId, attempt.executionId);
      const part = localSourceAsset(
        localAppendBase.id,
        uploadedSourceContentHash,
        session.file_name,
        canonicalContentType,
        original.size,
        Number(localAppendBase.chapter_index) + 1,
      );
      const key = `${session.user_id}/${part.bookId}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${part.id}/original`;
      await reserveObjectDeletions(pool, [key], 'import_source_part_staging');
      await putRawBookObject(s3Client, config, key, original, canonicalContentType, importAbort.signal);
      uploadedObjectKeys.push(key);
      storedAssets.push({ ...part, storageKey: key });
      const source = localAppendSource(localAppendBase, storedAssets);
      parsed = offsetLocalAppend(
        parsed,
        localAppendBase,
        uploadedSourceContentHash,
        session.file_name.replace(/\.(epub|zip|cbz)$/iu, ''),
      );
      sourceBlob = source.blob;
      sourceContentHash = source.hash;
      canonicalContentType = LOCAL_ARCHIVE_SERIES_TYPE;
      canonicalFileName = 'boaa-local-series.json';
      parsed.novel.rawTextHash = source.hash;
      parsed.novel.sourceContentHash = source.hash;
      parsed.novel.sourceFileName = canonicalFileName;
      parsed.novel.sourceContentType = canonicalContentType;
    }
    measurements.counts.pageCount =
      parsed.novel.format === 'image_archive' || parsed.novel.format === 'pdf' ? parsed.chapters.length : 0;
    await updateImportJobProgress(
      pool,
      jobId,
      {
        status: 'processing',
        stage: 'writing',
        bytesRead,
        totalBytes,
        chaptersDetected: parsed.chapters.length,
        paragraphsWritten: 0,
        message: '원본 저장 중',
      },
      attempt.executionId,
    );
    const rawHash = parsed.novel.rawTextHash;
    let objectId = persistentId128('object', [session.user_id, rawHash]);
    const storageKey = `${session.user_id}/sources/${objectId}/${jobId}/${attempt.executionId ?? randomUUID()}/attempt-${attempt.attemptNumber}/${canonicalFileName}`;
    const canonicalSizeBytes = sourceBlob.size;
    measurements.counts.canonicalBytes = canonicalSizeBytes;
    measurements.start('write_source');

    await assertImportExecutionActive(pool, jobId, attempt.executionId);
    await reserveObjectDeletions(pool, [storageKey], 'import_source_staging');
    await putRawBookObject(s3Client, config, storageKey, sourceBlob, canonicalContentType, importAbort.signal);
    uploadedObjectKeys.push(storageKey);
    measurements.start('write_assets');
    if (parsed.consumeEmbeddedAssets || parsed.embeddedAssets?.length)
      await updateImportJobProgress(pool, jobId, { message: '이미지 저장 중' }, attempt.executionId);
    const reusePage =
      incrementalImageSeriesAppend && appendLockClient
        ? await loadImportPageReuse(appendLockClient, session.user_id, parsed.novel.id, (key) =>
            inspectStoredObject(s3Client, config, key),
          )
        : undefined;
    if (comicPlan && appendLockClient) {
      const retained = await retainComicAssets({
        client: appendLockClient,
        userId: session.user_id,
        bookId: parsed.novel.id,
        plan: comicPlan,
        pageParts: comicPagePartsToRead,
        pageIds: comicPageIdsToRead,
        inspect: (key) => inspectStoredObject(s3Client, config, key),
        read: async (key) => new Blob([arrayBufferFromBuffer((await getObjectBuffer(s3Client, config, key)).body)]),
      });
      storedAssets.push(...retained);
      measurements.counts.reusedPages += retained.filter((asset) => asset.kind === 'document_page').length;
      measurements.counts.reusedPageBytes += retained
        .filter((asset) => asset.kind === 'document_page')
        .reduce((sum, asset) => sum + asset.byteLength, 0);
    }
    const eagerAssets = (parsed.embeddedAssets ?? []).map((asset) => ({
      asset,
      storageKey: `${session.user_id}/${parsed.novel.id}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`,
    }));
    if (eagerAssets.length > 0) {
      await reserveObjectDeletions(
        pool,
        eagerAssets.map((entry) => entry.storageKey),
        'import_asset_staging',
      );
      let completedAssets = 0;
      for (const assetBatch of chunked(eagerAssets, SERVER_IMPORT_EAGER_ASSET_CONCURRENCY)) {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const outcomes = await Promise.allSettled(
          assetBatch.map(async ({ asset, storageKey: assetStorageKey }) => {
            await putRawBookObject(s3Client, config, assetStorageKey, Buffer.from(asset.bytes), asset.contentType);
            uploadedObjectKeys.push(assetStorageKey);
            const { bytes: _releasedBytes, ...metadata } = asset;
            return { ...metadata, byteLength: asset.bytes.byteLength, storageKey: assetStorageKey };
          }),
        );
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        storedAssets.push(
          ...outcomes
            .filter(
              (outcome): outcome is PromiseFulfilledResult<(typeof storedAssets)[number]> =>
                outcome.status === 'fulfilled',
            )
            .map((outcome) => outcome.value),
        );
        completedAssets += assetBatch.length;
        await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            message: `이미지 저장 ${completedAssets.toLocaleString()}/${eagerAssets.length.toLocaleString()}`,
            progressCompleted: completedAssets,
            progressTotal: eagerAssets.length,
            progressUnit: 'images',
          },
          attempt.executionId,
        );
      }
    }
    if (parsed.consumeEmbeddedAssets) {
      let streamedAssets = 0;
      const shouldReportAssets = createImportProgressUpdateThrottle();
      let assetBatch: Array<{ asset: ParsedNovelImportAsset; storageKey: string }> = [];
      const flushAssetBatch = async () => {
        if (assetBatch.length === 0) return;
        const pendingBatch = assetBatch;
        assetBatch = [];
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const currentBatch = await Promise.all(
          pendingBatch.map(async (entry) => {
            const existingKey = await reusePage?.(entry.asset);
            return { ...entry, storageKey: existingKey ?? entry.storageKey, reused: existingKey !== undefined };
          }),
        );
        await reserveObjectDeletions(
          pool,
          currentBatch.filter((entry) => !entry.reused).map((entry) => entry.storageKey),
          'import_asset_staging',
        );
        const outcomes = await Promise.allSettled(
          currentBatch.map(async ({ asset, storageKey: assetStorageKey, reused }) => {
            if (!reused) {
              await putRawBookObject(s3Client, config, assetStorageKey, Buffer.from(asset.bytes), asset.contentType);
              // Only newly written objects belong to this attempt's failure cleanup.
              uploadedObjectKeys.push(assetStorageKey);
            }
            if (asset.kind === 'document_page') {
              if (reused) {
                measurements.counts.reusedPages += 1;
                measurements.counts.reusedPageBytes += asset.bytes.byteLength;
              } else {
                measurements.counts.writtenPages += 1;
                measurements.counts.writtenPageBytes += asset.bytes.byteLength;
              }
            }
            const { bytes: _releasedBytes, ...metadata } = asset;
            return { ...metadata, byteLength: asset.bytes.byteLength, storageKey: assetStorageKey };
          }),
        );
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (failed) throw failed.reason;
        storedAssets.push(
          ...outcomes
            .filter(
              (outcome): outcome is PromiseFulfilledResult<(typeof storedAssets)[number]> =>
                outcome.status === 'fulfilled',
            )
            .map((outcome) => outcome.value),
        );
        streamedAssets += currentBatch.length;
        if (shouldReportAssets()) {
          await updateImportJobProgress(
            pool,
            jobId,
            {
              status: 'processing',
              stage: 'writing',
              message: `이미지 저장 ${streamedAssets.toLocaleString()}개`,
              progressUnit: 'images',
              progressCompleted: streamedAssets,
              progressTotal: parsed.embeddedAssetCount,
            },
            attempt.executionId,
          );
        }
      };
      for await (const asset of parsed.consumeEmbeddedAssets()) {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
        const assetStorageKey = `${session.user_id}/${parsed.novel.id}/staged/${jobId}/${attempt.executionId ?? 'legacy'}/attempt-${attempt.attemptNumber}/${asset.id}/${asset.fileName}`;
        assetBatch.push({ asset, storageKey: assetStorageKey });
        if (assetBatch.length >= SERVER_IMPORT_EAGER_ASSET_CONCURRENCY) await flushAssetBatch();
      }
      await flushAssetBatch();
      if (streamedAssets > 0) {
        await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            message: `이미지 저장 ${streamedAssets.toLocaleString()}개`,
            progressUnit: 'images',
            progressCompleted: streamedAssets,
            progressTotal: parsed.embeddedAssetCount,
          },
          attempt.executionId,
        );
      }
    }
    await assertImportExecutionActive(pool, jobId, attempt.executionId);

    await updateImportJobProgress(pool, jobId, { message: '마무리 중', progressUnit: null }, attempt.executionId);
    measurements.start('database_pool');
    const client = appendLockClient ?? (await pool.connect());
    measurements.start('commit_database');
    const releaseTransactionClient = client !== appendLockClient;
    try {
      await client.query('begin');
      // The materializer's final ID may differ from client_book_id. Lock that
      // identity before replacement preparation can delete or rewrite children.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`import-book:${parsed.novel.id}`]);
      const finalTarget = await client.query<{ user_id: string }>(
        'select user_id from library_books where id=$1 for update',
        [parsed.novel.id],
      );
      if (finalTarget.rows[0] && finalTarget.rows[0].user_id !== session.user_id)
        throw new Error('import_target_not_found');
      await assertImportExpectedBase(client, { bookId: parsed.novel.id, userId: session.user_id, expectedBase });
      if (appendBaseContentRevisionId) {
        const currentBase = await client.query<{ id: string }>(
          `select id from library_books
            where id = $1 and user_id = $2 and active_content_revision_id = $3 and deleted_at is null
            for update`,
          [parsed.novel.id, session.user_id, appendBaseContentRevisionId],
        );
        if (!currentBase.rows[0]) throw new Error('image_series_append_base_changed');
      }
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${session.user_id}:${rawHash}`]);
      const previousSource = await client.query<{ id: string; storage_key: string }>(
        'select id, storage_key from book_objects where raw_text_hash = $1 and user_id = $2 for update',
        [rawHash, session.user_id],
      );
      objectId = previousSource.rows[0]?.id ?? objectId;
      const obsoleteSourceKeys = previousSource.rows.map((row) => row.storage_key).filter((key) => key !== storageKey);
      await client.query(
        `
          insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes, user_id)
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (user_id, raw_text_hash) do update
            set storage_key = excluded.storage_key,
                file_name = excluded.file_name,
                content_type = excluded.content_type,
                size_bytes = excluded.size_bytes
        `,
        [objectId, rawHash, storageKey, canonicalFileName, canonicalContentType, canonicalSizeBytes, session.user_id],
      );
      const previousBookObject = await client.query<{ object_id?: string | null }>(
        'select object_id from library_books where id = $1 and user_id = $2',
        [parsed.novel.id, session.user_id],
      );
      const replacement = await prepareBookReplacement(client, {
        userId: session.user_id,
        bookId: parsed.novel.id,
        sourceObjectId: objectId,
        sourceRawTextHash: rawHash,
        normalizedTextHash: parsed.novel.normalizedTextHash,
        sourceFileName: parsed.novel.sourceFileName,
        sourceEncoding: parsed.novel.sourceEncoding,
      });
      const activatedBook = await client.query(
        `
          insert into library_books (
            id, user_id, object_id, format, title, author, description, language, source_file_name, source_encoding,
            normalized_text_hash, total_chapters, total_characters, total_paragraphs, cover_seed, favorite,
            document_section_count, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, false, $16, $17, $18)
          on conflict (id) do update
            set object_id = excluded.object_id,
                format = excluded.format,
                source_file_name = excluded.source_file_name,
                source_encoding = excluded.source_encoding,
                normalized_text_hash = excluded.normalized_text_hash,
                total_chapters = excluded.total_chapters,
                total_characters = excluded.total_characters,
                total_paragraphs = excluded.total_paragraphs,
                cover_seed = case
                  when $19::text in ('append_image_series','append_local_archive') then library_books.cover_seed
                  else excluded.cover_seed
                end,
                document_section_count = excluded.document_section_count,
                deleted_at = null,
                deleted_by_device_id = null,
                metadata_revision = case
                  when $19::text in ('append_image_series','append_local_archive') then library_books.metadata_revision
                  else library_books.metadata_revision + 1
                end,
                updated_at = excluded.updated_at
          where library_books.user_id = excluded.user_id and ($20::text is null or (
            $20::text = 'revision' and library_books.user_id = excluded.user_id and
            library_books.active_content_revision_id = $21::text
          ))
        `,
        [
          parsed.novel.id,
          session.user_id,
          objectId,
          parsed.novel.format ?? 'txt',
          parsed.novel.title,
          parsed.novel.author ?? null,
          parsed.novel.description ?? null,
          parsed.novel.language ?? null,
          parsed.novel.sourceFileName,
          parsed.novel.sourceEncoding,
          parsed.novel.normalizedTextHash,
          parsed.novel.totalChapters,
          parsed.novel.totalCharacters,
          parsed.novel.totalParagraphs,
          normalizeCoverSeedForPersistence(parsed.novel.coverSeed),
          parsed.novel.documentSectionCount ?? null,
          parsed.novel.createdAt,
          parsed.novel.updatedAt,
          importMode,
          expectedBase?.kind ?? null,
          expectedBase?.kind === 'revision' ? expectedBase.contentRevisionId : null,
        ],
      );
      if (activatedBook.rowCount !== 1)
        throw new Error(expectedBase ? 'import_expected_base_conflict' : 'import_target_not_found');
      if (previousBookObject.rows[0]?.object_id && previousBookObject.rows[0].object_id !== objectId) {
        const orphanedSource = await client.query<{ storage_key: string }>(
          `delete from book_objects object
            where object.id = $1
              and not exists (select 1 from library_books book where book.object_id = object.id)
            returning object.storage_key`,
          [previousBookObject.rows[0].object_id],
        );
        obsoleteSourceKeys.push(...orphanedSource.rows.map((row) => row.storage_key));
      }
      const activeCover = await client.query<{ id: string | null; provenance: string | null }>(
        `select asset.id, asset.provenance
           from library_books book
           left join book_assets asset on asset.id = book.cover_asset_id
          where book.id = $1 and book.user_id = $2`,
        [parsed.novel.id, session.user_id],
      );
      const preserveExistingCover =
        ((incrementalImageSeriesAppend || localArchiveAppend) && Boolean(activeCover.rows[0]?.id)) ||
        activeCover.rows[0]?.provenance === 'user_supplied' ||
        activeCover.rows[0]?.provenance === 'approved_enrichment';
      const removedAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets
          where book_id = $1 and user_id = $2 and kind in ('epub_resource', 'document_page', 'source_part') and status = 'active'
            and not (id = any($3::text[]))
          returning storage_key`,
        [
          parsed.novel.id,
          session.user_id,
          storedAssets
            .filter(
              (asset) =>
                asset.kind === 'epub_resource' || asset.kind === 'document_page' || asset.kind === 'source_part',
            )
            .map((asset) => asset.id),
        ],
      );
      const replacedAssetIds = storedAssets.map((asset) => asset.id);
      const replacedAssets = replacedAssetIds.length
        ? await client.query<{ id: string; storage_key: string }>(
            'select id, storage_key from book_assets where id = any($1::text[]) and user_id=$2',
            [replacedAssetIds, session.user_id],
          )
        : { rows: [] as Array<{ id: string; storage_key: string }> };
      const nextStorageById = new Map(storedAssets.map((asset) => [asset.id, asset.storageKey]));
      const obsoleteAssetKeys = [
        ...obsoleteSourceKeys,
        ...removedAssets.rows.map((row) => row.storage_key),
        ...replacedAssets.rows
          .filter((row) => nextStorageById.get(row.id) !== row.storage_key)
          .map((row) => row.storage_key),
      ];
      if (!preserveExistingCover) {
        const removedCovers = await client.query<{ storage_key: string }>(
          `delete from book_assets
            where book_id = $1 and user_id = $2 and kind = 'cover' and status = 'active'
            returning storage_key`,
          [parsed.novel.id, session.user_id],
        );
        obsoleteAssetKeys.push(...removedCovers.rows.map((row) => row.storage_key));
      }
      const staleAssets = await client.query<{ storage_key: string }>(
        `delete from book_assets
          where book_id = $1 and user_id = $2 and status = 'superseded' and kind <> 'cover'
          returning storage_key`,
        [parsed.novel.id, session.user_id],
      );
      obsoleteAssetKeys.push(...staleAssets.rows.map((row) => row.storage_key));
      const assetsToActivate = storedAssets.filter((asset) => !(asset.kind === 'cover' && preserveExistingCover));
      obsoleteAssetKeys.push(
        ...storedAssets
          .filter((asset) => asset.kind === 'cover' && preserveExistingCover)
          .map((asset) => asset.storageKey),
      );
      for (const asset of assetsToActivate) {
        const activatedAsset = await client.query(
          `insert into book_assets (
             id, user_id, book_id, content_revision_id, kind, provenance, status, storage_key, file_name,
             content_type, byte_length, content_hash, page_index, created_at, activated_at
           ) values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
           on conflict (id) do update set
             status = excluded.status, storage_key = excluded.storage_key, file_name = excluded.file_name,
             provenance = excluded.provenance, content_type = excluded.content_type,
             byte_length = excluded.byte_length, content_hash = excluded.content_hash,
             page_index = excluded.page_index, activated_at = now()
           where book_assets.user_id=excluded.user_id and book_assets.book_id=excluded.book_id`,
          [
            asset.id,
            session.user_id,
            parsed.novel.id,
            asset.kind,
            asset.provenance,
            'active',
            asset.storageKey,
            asset.fileName,
            asset.contentType,
            asset.byteLength,
            asset.contentHash,
            asset.pageIndex ?? null,
          ],
        );
        if (activatedAsset.rowCount !== 1) throw new Error('import_asset_parent_conflict');
      }
      const cover = assetsToActivate.find((asset) => asset.kind === 'cover');
      if (cover && !preserveExistingCover) {
        await client.query(
          `update library_books set cover_asset_id = $1, cover_fit = 'contain', cover_position_x = 50,
             cover_position_y = 50 where id = $2 and user_id = $3`,
          [cover.id, parsed.novel.id, session.user_id],
        );
      }
      measurements.start('write_rows');
      if (!localArchiveAppend) await replaceParsedBookContent(client, parsed.novel.id);
      if (localAppendBase?.format === 'image_archive')
        await promoteLocalComicSection(client, localAppendBase, session.user_id);
      for (const chapterBatch of chunked(parsed.chapters, SERVER_IMPORT_CHAPTER_BATCH_SIZE)) {
        await insertChapterBatch(client, chapterBatch);
      }
      let paragraphsWritten = 0;
      const shouldUpdateParagraphProgress = createImportProgressUpdateThrottle();
      for await (const pageBatch of iterateImportParagraphPageBatchesAsync(parsed, SERVER_IMPORT_PAGE_BATCH_SIZE)) {
        paragraphsWritten += await insertParagraphPageBatch(client, pageBatch);
        if (!shouldUpdateParagraphProgress()) continue;
        const progressUpdated = await updateImportJobProgress(
          pool,
          jobId,
          {
            status: 'processing',
            stage: 'writing',
            chaptersDetected: parsed.chapters.length,
            paragraphsWritten,
            progressUnit: 'paragraphs',
            progressCompleted: paragraphsWritten,
            progressTotal: parsed.novel.totalParagraphs,
            message: `본문 저장 ${paragraphsWritten.toLocaleString()}/${parsed.novel.totalParagraphs.toLocaleString()}`,
          },
          attempt.executionId,
        );
        if (attempt.executionId && !progressUpdated) throw new ImportExecutionStoppedError('cancelled');
      }
      await updateImportJobProgress(pool, jobId, { message: '마무리 중', progressUnit: null }, attempt.executionId);
      measurements.start('restore_reader_state');
      if (replacement) {
        await restoreExactAnchoredReaderState(client, replacement);
      }
      measurements.start('finalize_revision');
      if (replacement) await finalizeBookReplacement(client, replacement);
      const importPayload = { bookId: parsed.novel.id };
      const importRevision = {
        entityType: 'book',
        entityId: parsed.novel.id,
        novelId: parsed.novel.id,
        localSequence: 0,
        updatedAt: parsed.novel.updatedAt,
        payloadHash: syncPayloadIntegrityHash(importPayload),
      };
      await client.query(
        `
          insert into sync_events (id, user_id, type, book_id, entity_id, payload, revision, created_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (user_id, id) do nothing
        `,
        [
          persistentId128('sync_event', [
            session.user_id,
            'book_imported',
            parsed.novel.id,
            parsed.novel.updatedAt,
            ...(replacement ? [replacement.replacement.toContentRevisionId] : []),
          ]),
          session.user_id,
          'book_imported',
          parsed.novel.id,
          parsed.novel.id,
          JSON.stringify(importPayload),
          JSON.stringify(importRevision),
          parsed.novel.updatedAt,
        ],
      );
      const activatedUpload = await client.query(
        `update upload_sessions set status = 'imported', updated_at = now()
          where id = $1 and status = 'queued'
            and exists (
              select 1 from import_jobs
               where id = $2 and status = 'processing' and cancel_requested_at is null
                 ${attempt.executionId ? 'and active_queue_job_id = $3' : ''}
            )
          returning id`,
        attempt.executionId ? [uploadId, jobId, attempt.executionId] : [uploadId, jobId],
      );
      if (activatedUpload.rowCount === 0) {
        throw new ImportExecutionStoppedError('cancelled');
      }
      await client.query('delete from upload_chunks where upload_id = $1', [uploadId]);
      const finalized = await updateImportJobProgress(
        client,
        jobId,
        {
          status: 'done',
          stage: 'ready',
          bytesRead,
          totalBytes,
          chaptersDetected: parsed.chapters.length,
          paragraphsWritten: parsed.novel.totalParagraphs,
          message: '서버 가져오기가 완료되었습니다.',
          bookId: parsed.novel.id,
          errorMessage: null,
        },
        attempt.executionId,
      );
      if (attempt.executionId && !finalized) throw new ImportExecutionStoppedError('cancelled');
      await releaseObjectDeletionReservations(client, uploadedObjectKeys);
      // New asset ids can still point to an old immutable object. Preserve those
      // references atomically; never queue a reused page for replacement cleanup.
      const retainedAssetKeys = new Set(assetsToActivate.map((asset) => asset.storageKey));
      await enqueueObjectDeletions(
        client,
        obsoleteAssetKeys.filter((key) => !retainedAssetKeys.has(key)),
        'replaced_import_object',
      );
      await client.query('commit');
      importCommitted = true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      if (releaseTransactionClient) client.release();
    }
    measurements.start('cleanup');
    if (importCommitted) await removeUploadDirectory(config, uploadId);
  } catch (error) {
    if (!importCommitted && uploadedObjectKeys.length) {
      await enqueueObjectDeletions(pool, uploadedObjectKeys, 'abandoned_import_object').catch(() => undefined);
    }
    let stopped = error instanceof ImportExecutionStoppedError ? error : undefined;
    if (!stopped && attempt.executionId) {
      try {
        await assertImportExecutionActive(pool, jobId, attempt.executionId);
      } catch (executionError) {
        if (executionError instanceof ImportExecutionStoppedError) stopped = executionError;
      }
    }
    if (stopped) {
      if (stopped.reason === 'cancelled') {
        await pool.query('delete from upload_chunks where upload_id = $1', [uploadId]).catch(() => undefined);
        await removeUploadDirectory(config, uploadId);
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (attempt.finalAttempt) {
      await pool.query(
        "update upload_sessions set status = 'failed', updated_at = now() where id = $1 and status not in ('imported', 'cancelled')",
        [uploadId],
      );
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'failed',
          stage: 'failed',
          message: '서버 가져오기에 실패했습니다.',
          errorMessage: message,
        },
        attempt.executionId,
      );
    } else {
      await updateImportJobProgress(
        pool,
        jobId,
        {
          status: 'queued',
          stage: 'queued',
          message: `서버 가져오기를 재시도합니다. (${attempt.attemptNumber}/${attempt.maxAttempts} 실패)`,
          errorMessage: message,
        },
        attempt.executionId,
      );
    }
    throw error;
  } finally {
    stopHeartbeat();
    await disposeUploadFile?.().catch(() => undefined);
    measurements.finish(importCommitted ? (appendNoop ? 'noop' : 'committed') : 'not_committed');
    if (appendLockClient && appendLockBookId) {
      await unlockImageSeriesAppend(appendLockClient, appendLockBookId).catch(() => undefined);
    }
  }
}
