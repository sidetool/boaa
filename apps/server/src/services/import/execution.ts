import type pg from 'pg';

type ImportJobStage =
  'queued' | 'reading' | 'decoding' | 'splitting_chapters' | 'writing' | 'ready' | 'failed' | 'cancelled';

export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface ImportJobProgressPatch {
  status?: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';
  stage?: ImportJobStage;
  bytesRead?: number;
  totalBytes?: number;
  chaptersDetected?: number;
  paragraphsWritten?: number;
  message?: string | null;
  bookId?: string;
  errorMessage?: string | null;
  progressCompleted?: number;
  progressTotal?: number;
  progressUnit?: 'images' | 'paragraphs' | null;
}

export interface ImportExecutionAttempt {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly finalAttempt: boolean;
  readonly executionId?: string;
}

export const SINGLE_IMPORT_ATTEMPT: ImportExecutionAttempt = {
  attemptNumber: 1,
  maxAttempts: 1,
  finalAttempt: true,
};

const IMPORT_JOB_HEARTBEAT_MS = 30_000;

export async function updateImportJobProgress(
  queryable: Queryable,
  jobId: string,
  patch: ImportJobProgressPatch,
  executionId?: string,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const setValue = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.status !== undefined) setValue('status', patch.status);
  if (patch.stage !== undefined) setValue('stage', patch.stage);
  if (patch.stage !== undefined || patch.progressUnit !== undefined) {
    setValue('progress_completed', patch.progressCompleted ?? null);
    setValue('progress_total', patch.progressTotal ?? null);
    setValue('progress_unit', patch.progressUnit ?? null);
  }
  if (patch.bytesRead !== undefined) setValue('bytes_read', Math.max(0, Math.round(patch.bytesRead)));
  if (patch.totalBytes !== undefined) setValue('total_bytes', Math.max(0, Math.round(patch.totalBytes)));
  if (patch.chaptersDetected !== undefined)
    setValue('chapters_detected', Math.max(0, Math.round(patch.chaptersDetected)));
  if (patch.paragraphsWritten !== undefined)
    setValue('paragraphs_written', Math.max(0, Math.round(patch.paragraphsWritten)));
  if (patch.message !== undefined) setValue('message', patch.message);
  if (patch.bookId !== undefined) setValue('book_id', patch.bookId);
  if (patch.errorMessage !== undefined) setValue('error_message', patch.errorMessage);
  if (!assignments.length) return true;

  values.push(jobId);
  const jobParameter = values.length;
  if (executionId) values.push(executionId);
  const result = await queryable.query(
    `update import_jobs set ${assignments.join(', ')}, updated_at = now()
      where id = $${jobParameter}${
        executionId
          ? ` and active_queue_job_id = $${values.length} and cancel_requested_at is null and status <> 'cancelled'`
          : ''
      }`,
    values,
  );
  const rowCount = (result as pg.QueryResult).rowCount;
  return rowCount === undefined || rowCount === null || rowCount > 0;
}

export class ImportExecutionStoppedError extends Error {
  constructor(readonly reason: 'cancelled' | 'superseded') {
    super(reason === 'cancelled' ? 'Import was cancelled' : 'Import execution was superseded');
    this.name = 'ImportExecutionStoppedError';
  }
}

export async function claimImportExecution(pool: pg.Pool, jobId: string, executionId?: string): Promise<boolean> {
  if (!executionId) return true;
  const result = await pool.query(
    `update import_jobs
        set status = 'processing', stage = 'reading', message = '파일 준비 중',
            error_message = null, updated_at = now()
      where id = $1 and status = 'queued' and active_queue_job_id = $2 and cancel_requested_at is null
      returning id`,
    [jobId, executionId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function assertImportExecutionActive(pool: pg.Pool, jobId: string, executionId?: string): Promise<void> {
  if (!executionId) return;
  const result = await pool.query<{
    status: string;
    cancel_requested_at?: string | null;
    active_queue_job_id?: string | null;
  }>('select status, cancel_requested_at, active_queue_job_id from import_jobs where id = $1', [jobId]);
  const row = result.rows[0];
  if (row?.cancel_requested_at || row?.status === 'cancelled') throw new ImportExecutionStoppedError('cancelled');
  if (!row || row.active_queue_job_id !== executionId || row.status !== 'processing') {
    throw new ImportExecutionStoppedError('superseded');
  }
}

export function startImportHeartbeat(
  pool: pg.Pool,
  jobId: string,
  importAbort: AbortController,
  executionId?: string,
): () => void {
  const heartbeat = setInterval(() => {
    void pool
      .query(
        `update import_jobs set updated_at = now()
          where id = $1 and status = 'processing'${executionId ? ' and active_queue_job_id = $2 and cancel_requested_at is null' : ''}`,
        executionId ? [jobId, executionId] : [jobId],
      )
      .then((result) => {
        if (executionId && (result.rowCount ?? 0) === 0) importAbort.abort();
      })
      .catch(() => undefined);
  }, IMPORT_JOB_HEARTBEAT_MS);
  heartbeat.unref();

  return () => clearInterval(heartbeat);
}
