import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type {
  SpeakerCleanupOptions,
  SpeakerCleanupPreview,
  SpeakerCleanupResult,
} from '../../../../src/providers/speaker-generation';
import type { AudiobookAudioStore } from './audiobook-audio.js';
import { audiobookError } from './audiobook-plan.js';

type Database = Pick<pg.Pool, 'query'>;
function validate(options: SpeakerCleanupOptions) {
  if (
    !options ||
    ['audio', 'settings', 'analysis'].some((key) => typeof options[key as keyof SpeakerCleanupOptions] !== 'boolean')
  )
    throw audiobookError(400, '지울 항목을 선택해 주세요.');
}
async function snapshot(db: Database, owner: string, bookId: string, options: SpeakerCleanupOptions) {
  validate(options);
  const book = (
    await db.query(
      'select active_content_revision_id from library_books where id=$1 and user_id=$2 and deleted_at is null',
      [bookId, owner],
    )
  ).rows[0];
  if (!book) throw audiobookError(404, '작품을 찾을 수 없어요.');
  const jobs = (
    await db.query(
      `select a.id,a.status,a.bytes,a.planning_complete,a.updated_at,r.analysis_key,
    exists(select 1 from saved_audiobook_items i where i.audiobook_id=a.id and i.status='dispatching') dispatching
    from saved_audiobooks a left join speaker_generation_runs r on r.audiobook_id=a.id
    where a.book_id=$1 and a.user_id=$2 order by a.id`,
      [bookId, owner],
    )
  ).rows;
  const assignments = (
    await db.query(
      'select * from speaker_voice_bindings where book_id=$1 and user_id=$2 order by analysis_key,speaker_id',
      [bookId, owner],
    )
  ).rows;
  const analyses = (
    await db.query(
      'select analysis_key,chapter_id,updated_at,bytes from speaker_analysis where book_id=$1 and user_id=$2 order by analysis_key,chapter_id',
      [bookId, owner],
    )
  ).rows;
  const preferences = (
    await db.query('select value from speaker_generation_preferences where book_id=$1 and user_id=$2', [bookId, owner])
  ).rows[0]?.value;
  const blockedReason = jobs.some(
    (j) => ['queued', 'running', 'pausing', 'deleting'].includes(j.status) || j.dispatching,
  )
    ? '만드는 중인 작업을 멈춘 뒤 초기화할 수 있어요.'
    : options.analysis && !options.audio && jobs.some((j) => j.analysis_key && !j.planning_complete)
      ? '분석이 끝나지 않은 생성 작업도 함께 삭제해 주세요.'
      : undefined;
  const preview: SpeakerCleanupPreview = {
    fingerprint: structuredIntegrityHash({
      owner,
      bookId,
      book,
      options: { audio: options.audio, settings: options.settings, analysis: options.analysis },
      jobs,
      assignments,
      analyses,
      preferences,
    }),
    jobCount: jobs.length,
    audioBytes: jobs.reduce((sum, j) => sum + Number(j.bytes), 0),
    assignmentCount: assignments.length,
    analysisCount: analyses.length,
    blockedReason,
  };
  return { preview, jobs, preferences };
}
export async function previewSpeakerCleanup(
  pool: pg.Pool,
  owner: string,
  bookId: string,
  options: SpeakerCleanupOptions,
) {
  return (await snapshot(pool, owner, bookId, options)).preview;
}

/** Explicit book-wide cleanup; shared voices, connections and source text are never targets. */
export async function cleanupSpeakerBook(
  pool: pg.Pool,
  owner: string,
  audioStore: AudiobookAudioStore,
  bookId: string,
  options: SpeakerCleanupOptions,
  fingerprint: string,
  confirm: boolean,
): Promise<SpeakerCleanupResult> {
  validate(options);
  if (confirm !== true || !(options.audio || options.settings || options.analysis))
    throw audiobookError(400, '지울 항목을 확인해 주세요.');
  const db = await pool.connect();
  let jobIds: string[] = [];
  let result: SpeakerCleanupResult;
  try {
    await db.query('begin');
    // Same lock order as analysis writes; the audio owner lock serializes create/resume.
    await db.query('select id from users where id=$1 for update', [owner]);
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`audiobook:${owner}`]);
    await db.query('select id from library_books where id=$1 and user_id=$2 and deleted_at is null for update', [
      bookId,
      owner,
    ]);
    await db.query('select id from saved_audiobooks where book_id=$1 and user_id=$2 for update', [bookId, owner]);
    const denied = await db.query(
      "select 1 from self_host_accounts where user_id=$1 and (role<>'admin' or status<>'active') for share",
      [owner],
    );
    if (denied.rowCount) throw audiobookError(403, '초기화할 수 없는 계정이에요.');
    const current = await snapshot(db, owner, bookId, options);
    if (current.preview.blockedReason) throw audiobookError(409, current.preview.blockedReason);
    if (typeof fingerprint !== 'string' || current.preview.fingerprint !== fingerprint)
      throw audiobookError(409, '음성 정보가 바뀌었어요. 지울 내용을 다시 확인해 주세요.');
    for (const key of new Set(current.jobs.map((j) => j.analysis_key).filter(Boolean))) {
      const locked = (
        await db.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) ok', [
          `speaker:${owner}:${bookId}:${key}`,
        ])
      ).rows[0].ok;
      if (!locked) throw audiobookError(409, '진행 중인 요청이 끝난 뒤 다시 시도해 주세요.');
    }
    let removedAssignments = 0,
      removedAnalyses = 0;
    if (options.settings)
      removedAssignments =
        (await db.query('delete from speaker_voice_bindings where book_id=$1 and user_id=$2', [bookId, owner]))
          .rowCount ?? 0;
    if (options.analysis)
      removedAnalyses =
        (await db.query('delete from speaker_analysis where book_id=$1 and user_id=$2', [bookId, owner])).rowCount ?? 0;
    else if (options.audio) {
      // No retained jobs can own an interrupted dispatch after the explicit audio cleanup.
      // Completed results and valid checkpoints/responses remain reusable without another model call.
      await db.query(
        `update speaker_analysis set dispatching=false,response_rejected=false,
        model_response=case when response_rejected then null else model_response end,
        bytes=octet_length(coalesce(checkpoint::text,''))+octet_length(coalesce(result::text,''))+
          case when response_rejected then 0 else octet_length(coalesce(model_response,'')) end,updated_at=now()
        where book_id=$1 and user_id=$2 and result is null and (dispatching or response_rejected)`,
        [bookId, owner],
      );
    }
    const preferences = options.settings
      ? { engineId: current.preferences?.engineId ?? '', narratorVoiceId: '', characterVoiceIds: [] }
      : (current.preferences ?? { engineId: '', narratorVoiceId: '', characterVoiceIds: [] });
    // Server-only generation identity changes, but the analysis key does not.
    const value = { ...preferences, generationEpoch: randomUUID() };
    await db.query(
      `insert into speaker_generation_preferences(book_id,user_id,value) values($1,$2,$3)
      on conflict(book_id) do update set value=excluded.value,updated_at=now()`,
      [bookId, owner, value],
    );
    if (options.audio) {
      jobIds = current.jobs.map((j) => j.id);
      await db.query("update saved_audiobooks set status='deleting',updated_at=now() where book_id=$1 and user_id=$2", [
        bookId,
        owner,
      ]);
    }
    result = {
      removedJobs: jobIds.length,
      removedAssignments,
      removedAnalyses,
      ...(options.settings ? { preferences } : {}),
    };
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
  // Durable deleting status lets the existing worker finish removal after a process interruption.
  for (const id of jobIds) {
    await audioStore.remove(id);
    await pool.query("delete from saved_audiobooks where id=$1 and user_id=$2 and status='deleting'", [id, owner]);
  }
  return result;
}
