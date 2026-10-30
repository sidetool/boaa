import { applyBookVoiceUpdates } from './speaker-book-voices';
import { savedAudioErrorMessage } from '../providers/gemini-audio-response';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AudiobookInput, SavedAudiobook, PreparedNarration } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSRequest, PlainTTSVoices, PlainTTSModel } from '../../../../src/providers/plain-tts';
import { AudiobookAudioStore, type SavedAudio } from './audiobook-audio.js';
import { audiobookError, planAudiobook, type AudiobookPlan } from './audiobook-plan.js';

const RUNNER_LOCK = '61879419263191';
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
class BackgroundYield extends Error {}
export const AUDIOBOOK_QUOTA_BYTES = 20 * 1024 ** 3;
type JobRow = {
  id: string;
  user_id: string;
  book_id: string;
  content_revision: string | null;
  title: string;
  settings: AudiobookInput;
  estimate: SavedAudiobook;
  status: SavedAudiobook['status'];
  completed_items: number;
  rate_limit_attempts: number;
  bytes: string;
  playback_index: number;
  current_chapter_title?: string;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
};
function view(row: JobRow): SavedAudiobook {
  return {
    ...row.estimate,
    id: row.id,
    bookId: row.book_id,
    chapterIds: row.settings.chapterIds,
    title: row.title,
    status: row.status,
    completedItems: row.completed_items,
    bytes: Number(row.bytes),
    playbackIndex: row.playback_index,
    currentChapterTitle: row.current_chapter_title ?? undefined,
    error: savedAudioErrorMessage(row.error_message),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class AudiobookService {
  speaker?: {
    advance(id: string, signal: AbortSignal, admit?: () => boolean): Promise<void | boolean>;
    reader(id: string, chapterId: string): Promise<PreparedNarration>;
    render(id: string, ordinal: number, regenerate: boolean): Promise<SavedAudio>;
    resume(id: string): Promise<void>;
  };
  private active?: { id: string; abort: AbortController };
  private lastCleanup = 0;
  private closing = false;
  private foreground = 0;
  private items = new Map<string, { task: Promise<SavedAudio>; regenerate: boolean }>();
  async stop() {
    this.closing = true;
    if (this.active) {
      this.active.abort.abort();
      await this.pool.query(
        "update saved_audiobooks set status='pausing' where id=$1 and user_id=$2 and status='running'",
        [this.active.id, this.owner],
      );
    }
    await Promise.allSettled([...this.items.values()].map(({ task }) => task));
  }
  constructor(
    private readonly pool: pg.Pool,
    private readonly owner: string,
    readonly audioStore: AudiobookAudioStore,
    private readonly catalog: () => Promise<PlainTTSVoices>,
    private readonly render: (
      chapterId: string,
      request: PlainTTSRequest,
      model?: PlainTTSModel,
    ) => Promise<SavedAudio>,
    private readonly failure: (error: unknown) => { message: string; status: number },
    private readonly resolveModel?: (
      settings: AudiobookInput,
      probe: { chapterId: string; request: PlainTTSRequest; key?: string },
    ) => Promise<PlainTTSModel>,
    private readonly backgroundConcurrency: (settings: AudiobookInput) => Promise<1 | 2> = async () => 1,
  ) {}

  async plan(bookId: string, settings: AudiobookInput) {
    return planAudiobook(this.pool, this.owner, bookId, settings, await this.catalog());
  }
  async list(bookId: string): Promise<SavedAudiobook[]> {
    return (
      await this.pool.query(
        `select a.* from saved_audiobooks a join library_books b on b.id=a.book_id
      where a.book_id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null and not(a.settings ? 'cast') order by a.created_at desc limit 50`,
        [bookId, this.owner],
      )
    ).rows.map(view);
  }
  async get(id: string): Promise<JobRow> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw audiobookError(400, '오디오북 ID가 올바르지 않습니다.');
    const row = (
      await this.pool.query(
        `select a.* from saved_audiobooks a join library_books b on b.id=a.book_id
      where a.id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null`,
        [id, this.owner],
      )
    ).rows[0];
    if (!row) throw audiobookError(404, '저장한 오디오북을 찾을 수 없습니다.');
    return row;
  }
  /** Rebuild source anchors from the recording's plan, not the listener's current chunk/filter settings. */
  async reader(
    bookId: string,
    chapterId: string,
    choice: { id?: string; voiceId?: string },
  ): Promise<PreparedNarration | undefined> {
    const row = (
      await this.pool.query(
        `select a.* from saved_audiobooks a join library_books b on b.id=a.book_id
      where a.book_id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null and a.status<>'deleting'
      and a.content_revision is not distinct from b.active_content_revision_id
      and (exists(select 1 from saved_audiobook_items i where i.audiobook_id=a.id and i.chapter_id=$3) or (a.settings ? 'cast' and a.settings->'chapterIds' ? $3))
      and ($4::text is null or a.id::text=$4) and ($4::text is not null or a.settings->>'voiceId'=$5)
      order by (exists(select 1 from saved_audiobook_items i where i.audiobook_id=a.id and i.chapter_id=$3)
        and not exists(select 1 from saved_audiobook_items i where i.audiobook_id=a.id and i.chapter_id=$3 and i.status<>'ready')) desc,
        a.created_at desc limit 1`,
        [bookId, this.owner, chapterId, choice.id ?? null, choice.voiceId ?? null],
      )
    ).rows[0] as JobRow | undefined;
    if (!row) return;
    if (row.settings.cast) {
      if (!this.speaker) throw audiobookError(503, '화자별 음성 연결을 준비 중이에요.');
      return this.speaker.reader(row.id, chapterId);
    }
    const plan = await planAudiobook(this.pool, this.owner, bookId, { ...row.settings, chapterIds: [chapterId] });
    const saved = (
      await this.pool.query(
        'select ordinal,request,status from saved_audiobook_items where audiobook_id=$1 and chapter_id=$2 order by ordinal',
        [row.id, chapterId],
      )
    ).rows;
    if (plan.items.length !== saved.length)
      throw audiobookError(409, '본문 구성이 변경되어 미리 만든 음성을 연결하지 못했어요.');
    return {
      id: row.id,
      chapterId,
      contentRevision: row.content_revision ?? undefined,
      voiceLabel: row.estimate.voiceLabel,
      items: plan.items.map((item, index) => {
        const old = saved[index];
        if (
          old.request.chunkHash !== item.request.chunkHash ||
          old.request.paragraphHash !== item.request.paragraphHash
        )
          throw audiobookError(409, '본문이 변경되어 미리 만든 음성을 연결하지 못했어요.');
        return {
          ordinal: old.ordinal,
          paragraphIndex: item.paragraphIndex,
          nextParagraphIndex: item.nextParagraphIndex,
          playable: {
            ...item.playable,
            speakerLabel: row.estimate.voiceLabel,
            preparedAudio: { id: row.id, ordinal: old.ordinal, ready: old.status === 'ready' },
          },
        };
      }),
    };
  }
  private async model(job: JobRow) {
    if (job.settings.cast) return undefined;
    if (job.settings.model || !this.resolveModel) return job.settings.model;
    // Older plans did not store model identity. Prove it from their existing audio key (or unchanged catalog).
    const probe = (
      await this.pool.query(
        `select chapter_id,request,cache_key from saved_audiobook_items where audiobook_id=$1 order by (status='ready') desc,ordinal limit 1`,
        [job.id],
      )
    ).rows[0];
    const model = await this.resolveModel(job.settings, {
      chapterId: probe.chapter_id,
      request: probe.request,
      key: probe.cache_key ?? undefined,
    });
    await this.pool.query(
      "update saved_audiobooks set settings=jsonb_set(settings,'{model}',$2::jsonb) where id=$1 and user_id=$3",
      [job.id, JSON.stringify(model), this.owner],
    );
    job.settings = { ...job.settings, model };
    return model;
  }
  /** Foreground and background use the same item and file, including in-flight requests. */
  async resolve(id: string, ordinal: number, regenerate = false): Promise<SavedAudio> {
    this.foreground++;
    try {
      const job = await this.get(id);
      try {
        return await this.ensureItem(job, ordinal, regenerate);
      } catch (error) {
        // A joined background admission may have yielded before dispatch. Listening can still own this item.
        if (!(error instanceof BackgroundYield)) throw error;
        return await this.ensureItem(job, ordinal, regenerate);
      }
    } catch (error) {
      // Do not let the background runner automatically repeat an ambiguous foreground failure.
      const failure = this.failure(error);
      const status = (error as { statusCode?: number })?.statusCode ?? failure.status;
      if (status !== 429 && status !== 425 && /^[a-f0-9-]{36}$/.test(id))
        await this.pool.query(
          `update saved_audiobooks set status='failed',error_message=$3,updated_at=now()
          where id=$1 and user_id=$2 and status in ('queued','running')`,
          [id, this.owner, (error as { statusCode?: number }).statusCode ? (error as Error).message : failure.message],
        );
      throw error;
    } finally {
      this.foreground--;
    }
  }
  private ensureItem(job: JobRow, ordinal: number, regenerate = false, background = false): Promise<SavedAudio> {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0)
      return Promise.reject(audiobookError(400, '낭독 위치를 확인해 주세요.'));
    const key = job.id + ':' + ordinal;
    const old = this.items.get(key);
    if (old) {
      if (regenerate && !old.regenerate) return old.task.then(() => this.ensureItem(job, ordinal, true));
      return old.task;
    }
    const task = this.writeItem(job, ordinal, regenerate, background).finally(() => {
      if (this.items.get(key)?.task === task) this.items.delete(key);
    });
    this.items.set(key, { task, regenerate });
    return task;
  }
  private async writeItem(job: JobRow, ordinal: number, regenerate: boolean, background: boolean): Promise<SavedAudio> {
    const client = await this.pool.connect();
    let locked = false;
    const lock = 'prepared-narration:' + job.id + ':' + ordinal;
    try {
      // Cross-process item fence. Waiting listeners share the completed file without a second provider call.
      await client.query('select pg_advisory_lock(hashtextextended($1,0))', [lock]);
      locked = true;
      if (this.closing) {
        if (background) throw new BackgroundYield();
        throw audiobookError(503, '서버가 잠시 다시 시작 중입니다.');
      }
      const item = (
        await client.query(
          `select i.* from saved_audiobook_items i join saved_audiobooks a on a.id=i.audiobook_id
        join library_books b on b.id=a.book_id where i.audiobook_id=$1 and i.ordinal=$2 and a.user_id=$3 and b.user_id=$3
        and a.status<>'deleting' and b.deleted_at is null and a.content_revision is not distinct from b.active_content_revision_id`,
          [job.id, ordinal, this.owner],
        )
      ).rows[0];
      if (!item) throw audiobookError(409, '본문 또는 미리 만든 음성의 위치가 변경됐습니다.');
      const stored = regenerate ? undefined : await this.audioStore.get(job.id, ordinal);
      if (stored && item.status === 'ready') return stored;
      if (!stored && item.status === 'dispatching')
        throw audiobookError(409, '중단된 생성 요청이 있어요. 미리 생성하기에서 이어 만들기를 눌러 주세요.');
      if (!stored && item.status === 'ready' && !regenerate)
        throw audiobookError(410, '음성 파일을 읽지 못했어요. 현재 음성 다시 만들기를 눌러 주세요.');
      let audio = stored;
      if (!audio) {
        const model = await this.model(job);
        const account = (
          await client.query(
            "select 1 from self_host_accounts where user_id=$1 and (role<>'admin' or status<>'active')",
            [this.owner],
          )
        ).rows[0];
        if (account) throw audiobookError(403, '계정 권한이 변경되었습니다.');
        await client.query('begin');
        // Reserve space for each in-flight response, including other jobs and foreground listeners.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`audiobook:${this.owner}`]);
        const usage = (
          await client.query(
            `select coalesce(sum(bytes),0) bytes,
            (select count(*) from saved_audiobook_items i join saved_audiobooks a on a.id=i.audiobook_id
             where a.user_id=$1 and i.status='dispatching') pending
            from saved_audiobooks where user_id=$1`,
            [this.owner],
          )
        ).rows[0];
        if (Number(usage.bytes) + (Number(usage.pending) + 1) * MAX_AUDIO_BYTES > AUDIOBOOK_QUOTA_BYTES)
          throw audiobookError(409, '음성 저장 공간이 가득 찼습니다.');
        const admitted = (
          await client.query(
            "select status from saved_audiobooks where id=$1 and user_id=$2 and status<>'deleting' for update",
            [job.id, this.owner],
          )
        ).rows[0];
        if (!admitted) throw audiobookError(409, '음성 작업이 삭제되었습니다.');
        if (background && (this.closing || admitted.status !== 'running')) throw new BackgroundYield();
        await client.query(
          "update saved_audiobook_items set status='dispatching' where audiobook_id=$1 and ordinal=$2",
          [job.id, ordinal],
        );
        await client.query('commit');
        try {
          audio = job.settings.cast
            ? await (this.speaker?.render(job.id, ordinal, regenerate) ??
                Promise.reject(audiobookError(503, '화자별 생성 연결을 확인해 주세요.')))
            : await this.render(
                item.chapter_id,
                { ...item.request, rules: job.settings.rules, ...(regenerate ? { regenerate: true } : {}) },
                model,
              );
        } catch (error) {
          await client.query('update saved_audiobook_items set status=$3 where audiobook_id=$1 and ordinal=$2', [
            job.id,
            ordinal,
            item.status === 'ready' ? 'ready' : 'pending',
          ]);
          throw error;
        }
      }
      if (!audio) throw audiobookError(502, '생성된 음성을 받지 못했어요.');
      await client.query('begin');
      const current = (
        await client.query(
          `select a.id from saved_audiobooks a join library_books b on b.id=a.book_id
        where a.id=$1 and a.user_id=$2 and a.status<>'deleting' and b.user_id=$2 and b.deleted_at is null
        and a.content_revision is not distinct from b.active_content_revision_id for update of a for share of b`,
          [job.id, this.owner],
        )
      ).rows[0];
      if (!current) throw audiobookError(409, '생성 중 본문 또는 작업이 변경됐습니다.');
      await this.audioStore.put(job.id, ordinal, audio);
      await client.query(
        "update saved_audiobook_items set status='ready',cache_key=$3,bytes=$4 where audiobook_id=$1 and ordinal=$2",
        [job.id, ordinal, audio.key, audio.data.length],
      );
      await client.query(
        `update saved_audiobooks a set completed_items=x.n,bytes=x.bytes,
        status=case when x.n=a.total_items and a.planning_complete then 'completed' else a.status end,updated_at=now()
        from (select count(*)::int n,coalesce(sum(bytes),0) bytes from saved_audiobook_items where audiobook_id=$1 and status='ready') x where a.id=$1`,
        [job.id],
      );
      await client.query('commit');
      return audio;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [lock]);
      client.release();
    }
  }
  async create(plan: AudiobookPlan, fingerprint: string, confirmPaid: boolean): Promise<SavedAudiobook> {
    if (fingerprint !== plan.estimate.fingerprint)
      throw audiobookError(409, '본문 또는 생성 범위가 변경됐습니다. 다시 확인해 주세요.');
    if (plan.estimate.paid && !confirmPaid) throw audiobookError(400, 'API 사용 비용을 확인한 뒤 시작해 주세요.');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`audiobook:${this.owner}`]);
      if (plan.generationEpoch !== undefined) {
        const epoch =
          (
            await client.query(
              "select value->>'generationEpoch' epoch from speaker_generation_preferences where book_id=$1 and user_id=$2",
              [plan.bookId, this.owner],
            )
          ).rows[0]?.epoch ?? null;
        if (epoch !== plan.generationEpoch)
          throw audiobookError(409, '음성 설정이 초기화됐어요. 생성 전 확인을 다시 해 주세요.');
      }
      const old = (
        await client.query('select * from saved_audiobooks where user_id=$1 and fingerprint=$2', [
          this.owner,
          fingerprint,
        ])
      ).rows[0];
      if (old) {
        await client.query('commit');
        return view(old);
      }
      const usage = (
        await client.query(
          'select count(*)::int as count,coalesce(sum(bytes),0) as bytes from saved_audiobooks where user_id=$1',
          [this.owner],
        )
      ).rows[0];
      if (usage.count >= 50 || Number(usage.bytes) >= AUDIOBOOK_QUOTA_BYTES)
        throw audiobookError(409, '저장 공간이 가득 찼습니다. 사용하지 않는 오디오북을 삭제해 주세요.');
      const book = (
        await client.query(
          'select active_content_revision_id from library_books where id=$1 and user_id=$2 and deleted_at is null for share',
          [plan.bookId, this.owner],
        )
      ).rows[0];
      if (!book || book.active_content_revision_id !== plan.revision)
        throw audiobookError(409, '본문이 변경됐습니다. 다시 확인해 주세요.');
      if (plan.revoiceSource) {
        await client.query('select user_id from self_host_accounts where user_id=$1 for share', [this.owner]);
        const original = await client.query(
          `select a.id from saved_audiobooks a join speaker_generation_runs r on r.audiobook_id=a.id
          where a.id=$1 and a.user_id=$2 and a.book_id=$3 and a.status in ('paused','failed','completed')
          and a.total_items=$4 and r.next_chapter=$5 and a.content_revision is not distinct from $6::text
          and not exists(select 1 from self_host_accounts where user_id=$2 and (role<>'admin' or status<>'active'))
          for share of a,r`,
          [
            plan.revoiceSource.id,
            this.owner,
            plan.bookId,
            plan.revoiceSource.itemCount,
            plan.revoiceSource.nextChapter,
            plan.revision,
          ],
        );
        if (!original.rowCount) throw audiobookError(409, '원래 작업이나 계정이 변경됐어요. 다시 확인해 주세요.');
      }
      const id = randomUUID();
      const row = (
        await client.query(
          `insert into saved_audiobooks(id,user_id,book_id,content_revision,fingerprint,title,settings,estimate,status,total_items,planning_complete)
        values($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10) returning *`,
          [
            id,
            this.owner,
            plan.bookId,
            plan.revision,
            fingerprint,
            plan.title,
            plan.settings,
            plan.estimate,
            plan.items.length,
            plan.planningComplete !== false,
          ],
        )
      ).rows[0];
      // Send bounded batches to PostgreSQL; requests contain source hashes, never raw book text.
      if (plan.speakerRun)
        await client.query(
          'insert into speaker_generation_runs(audiobook_id,analysis_key,chapter_ids,next_chapter,ledger,assignments,stage) values($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            plan.speakerRun.analysisKey,
            JSON.stringify(plan.speakerRun.chapterIds),
            plan.speakerRun.nextChapter ?? 0,
            plan.speakerRun.ledger ?? null,
            plan.speakerRun.assignments ?? {},
            plan.revoiceSource ? 'audio' : 'waiting',
          ],
        );
      for (let start = 0; start < plan.items.length; start += 250) {
        const rows = plan.items.slice(start, start + 250).map((item, index) => ({
          ordinal: start + index,
          chapter_id: item.chapterId,
          chapter_title: item.chapterTitle,
          request: item.request,
        }));
        await client.query(
          `insert into saved_audiobook_items(audiobook_id,ordinal,chapter_id,chapter_title,request)
          select $1,x.ordinal,x.chapter_id,x.chapter_title,x.request from jsonb_to_recordset($2::jsonb) as x(ordinal int,chapter_id text,chapter_title text,request jsonb)`,
          [id, JSON.stringify(rows)],
        );
      }
      if (plan.revoiceSource && plan.speakerRun && plan.bookVoiceUpdates?.length)
        await applyBookVoiceUpdates(
          client,
          this.owner,
          plan.bookId,
          plan.speakerRun.analysisKey,
          plan.bookVoiceUpdates,
          plan.settings.cast?.bookVoiceVersions ?? {},
        );
      await client.query('commit');
      return view(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async control(id: string, action: 'pause' | 'resume', confirmPaid = false): Promise<SavedAudiobook> {
    const job = await this.get(id);
    if (action === 'resume' && job.estimate.paid && !confirmPaid)
      throw audiobookError(400, '이어서 생성할 때 API 비용이 발생할 수 있습니다.');
    if (action === 'pause') {
      await this.pool.query(
        `update saved_audiobooks set status=case when status='running' then 'pausing' else 'paused' end,updated_at=now()
        where id=$1 and user_id=$2 and status in ('queued','running')`,
        [id, this.owner],
      );
      // Preserve the response to a paid analysis already in flight; pause before the next step.
      if (this.active?.id === id && !job.settings.cast) this.active.abort.abort();
    } else if (action === 'resume') {
      if (job.settings.cast) await this.speaker?.resume(id);
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const row = (
          await client.query(
            `update saved_audiobooks set status='queued',error_message=null,retry_at=null,rate_limit_attempts=0,updated_at=now()
          where id=$1 and user_id=$2 and status in ('paused','failed') returning id`,
            [id, this.owner],
          )
        ).rows[0];
        if (row)
          await client.query(
            "update saved_audiobook_items set status='pending' where audiobook_id=$1 and status='dispatching'",
            [id],
          );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } else throw audiobookError(400, '지원하지 않는 작업입니다.');
    return view(await this.get(id));
  }
  async remove(id: string): Promise<void> {
    await this.get(id);
    const changed = await this.pool.query(
      `update saved_audiobooks set status='deleting',updated_at=now() where id=$1 and user_id=$2
      and status not in ('running','pausing') and not exists(select 1 from saved_audiobook_items where audiobook_id=$1 and status='dispatching') returning id`,
      [id, this.owner],
    );
    if (!changed.rowCount) throw audiobookError(409, '생성을 중단한 뒤 삭제해 주세요.');
    await this.audioStore.remove(id);
    await this.pool.query("delete from saved_audiobooks where id=$1 and user_id=$2 and status='deleting'", [
      id,
      this.owner,
    ]);
  }
  async audio(id: string, ordinal: number): Promise<SavedAudio> {
    const job = await this.get(id);
    const ready =
      Number.isSafeInteger(ordinal) &&
      ordinal >= 0 &&
      (
        await this.pool.query(
          "select 1 from saved_audiobook_items where audiobook_id=$1 and ordinal=$2 and status='ready'",
          [id, ordinal],
        )
      ).rowCount;
    if (job.status === 'deleting' || !ready) throw audiobookError(404, '아직 저장되지 않은 음성입니다.');
    const audio = await this.audioStore.get(id, ordinal);
    if (!audio) throw audiobookError(410, '저장된 음성 파일이 없거나 손상됐습니다. 오디오북을 다시 만들어 주세요.');
    return audio;
  }
  async progress(id: string, index: number) {
    await this.get(id);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !(
        await this.pool.query(
          "select 1 from saved_audiobook_items where audiobook_id=$1 and ordinal=$2 and status='ready'",
          [id, index],
        )
      ).rowCount
    )
      throw audiobookError(400, '재생 위치가 올바르지 않습니다.');
    await this.pool.query('update saved_audiobooks set playback_index=$2 where id=$1 and user_id=$3', [
      id,
      index,
      this.owner,
    ]);
  }

  /** Drain already committed speech while the next analysis step waits for its provider. */
  private async advanceWithAudio(job: JobRow, signal: AbortSignal) {
    let finished = false;
    let stopped = false;
    const failures: unknown[] = [];
    const analysis = this.speaker!.advance(job.id, signal, () => !stopped)
      .catch((error) => {
        stopped = true;
        failures.push(error);
      })
      .finally(() => {
        finished = true;
      });
    try {
      while (!finished && !stopped && !signal.aborted && !this.closing) {
        const current = await this.get(job.id);
        if (current.status !== 'running') break;
        // Playback owns its requests; unprepared voices/acting must never be synthesized early.
        const items =
          this.foreground > 0 || current.settings.cast?.recastSpeakers?.length
            ? []
            : (
                await this.pool.query(
                  `select ordinal,chapter_title from saved_audiobook_items where audiobook_id=$1 and status<>'ready'
             and (not $2::boolean or request->'cast' ? 'performance') order by ordinal limit $3`,
                  [
                    job.id,
                    current.settings.cast?.autoActing === true,
                    current.rate_limit_attempts > 0 ? 1 : await this.backgroundConcurrency(current.settings),
                  ],
                )
              ).rows;
        if (!items.length) {
          // New spans are committed by the analysis lane; no paid request is sent while waiting.
          await Promise.race([analysis, new Promise((resolve) => setTimeout(resolve, 250))]);
          continue;
        }
        if (finished || stopped || signal.aborted || this.closing) break;
        await this.pool.query('update saved_audiobooks set current_chapter_title=$2 where id=$1', [
          job.id,
          items[0].chapter_title,
        ]);
        const batch = await Promise.allSettled(
          items.map((item) => this.ensureItem(current, item.ordinal, false, true)),
        );
        const errors = batch.flatMap((item) =>
          item.status === 'rejected' && !(item.reason instanceof BackgroundYield) ? [item.reason] : [],
        );
        if (errors.length) {
          stopped = true;
          failures.push(...errors);
        }
      }
    } catch (error) {
      stopped = true;
      failures.push(error);
    }
    // Never release the runner lock or requeue while either lane still has a paid request in flight.
    const result = await analysis;
    const permanent = failures.find((error) => this.failure(error).status !== 429);
    if (permanent) throw permanent;
    if (failures.length) {
      const retryAfter = (error: unknown) => {
        const detail = error as { retryAfterSeconds?: number; payload?: { retryAfterSeconds?: number } };
        return detail.retryAfterSeconds ?? detail.payload?.retryAfterSeconds ?? 0;
      };
      throw failures.reduce((a, b) => (retryAfter(a) >= retryAfter(b) ? a : b));
    }
    return result;
  }

  /** Keep the global lock until analysis and every dispatched audio item settle. */
  async tick(): Promise<boolean> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('select pg_try_advisory_lock($1::bigint) as locked', [RUNNER_LOCK])).rows[0].locked;
      if (!locked || this.closing || this.foreground > 0) return false;
      if (Date.now() - this.lastCleanup > 60_000) {
        const ids = await this.audioStore.ids();
        const existing = new Set(
          (await client.query('select id from saved_audiobooks where id=any($1::uuid[])', [ids])).rows.map(
            (row) => row.id,
          ),
        );
        for (const id of ids) if (!existing.has(id)) await this.audioStore.remove(id);
        const deleting = (
          await client.query("select id from saved_audiobooks where user_id=$1 and status='deleting'", [this.owner])
        ).rows;
        for (const row of deleting) {
          await this.audioStore.remove(row.id);
          await client.query("delete from saved_audiobooks where id=$1 and user_id=$2 and status='deleting'", [
            row.id,
            this.owner,
          ]);
        }
        this.lastCleanup = Date.now();
      }
      // A lost process may have dispatched a paid request. Require explicit resume instead of charging twice.
      await client.query(
        `update saved_audiobooks set status='paused',error_message='서버가 다시 시작되어 멈췄습니다. 이미 만든 음성은 보관돼 있어요. 이어 만들면 마지막 미완료 요청 비용이 다시 발생할 수 있어요.',updated_at=now()
        where user_id=$1 and status in ('running','pausing')`,
        [this.owner],
      );
      const job = (
        await client.query(
          `update saved_audiobooks set status='running',error_message=null,updated_at=now()
        where id=(select id from saved_audiobooks where user_id=$1 and status='queued' and (retry_at is null or retry_at<=now()) order by updated_at,id limit 1) and status='queued' returning *`,
          [this.owner],
        )
      ).rows[0] as JobRow | undefined;
      if (!job) return false;
      if (this.closing) {
        await client.query("update saved_audiobooks set status='queued' where id=$1 and status='running'", [job.id]);
        return false;
      }
      const abort = new AbortController();
      this.active = { id: job.id, abort };
      try {
        if (job.settings.cast) {
          if (!this.speaker) throw audiobookError(503, '화자별 생성 연결을 확인해 주세요.');
          if ((await this.advanceWithAudio(job, abort.signal)) === false) {
            await client.query(
              "update saved_audiobooks set status=case when status='pausing' then 'paused' else 'queued' end,updated_at=now() where id=$1 and status in ('running','pausing')",
              [job.id],
            );
            return false;
          }
        }
        // After a rate limit, probe with one request before restoring parallel work.
        const width = job.rate_limit_attempts > 0 ? 1 : await this.backgroundConcurrency(job.settings);
        const items = (
          await client.query(
            "select * from saved_audiobook_items where audiobook_id=$1 and status<>'ready' order by ordinal limit $2",
            [job.id, width === 2 ? 2 : 1],
          )
        ).rows;
        const item = items[0];
        if (!item) {
          await client.query(
            "update saved_audiobooks set status=case when status='pausing' then 'paused' when planning_complete and completed_items=total_items then 'completed' else 'queued' end,error_message=null,retry_at=null,rate_limit_attempts=0,updated_at=now() where id=$1 and status in ('running','pausing')",
            [job.id],
          );
          return false;
        }
        const authority = (
          await client.query(
            `select b.id from library_books b where b.id=$1 and b.user_id=$2 and b.deleted_at is null
          and b.active_content_revision_id is not distinct from $3::text
          and not exists(select 1 from self_host_accounts a where a.user_id=$2 and (a.role<>'admin' or a.status<>'active'))`,
            [job.book_id, this.owner, job.content_revision],
          )
        ).rows[0];
        if (!authority) throw audiobookError(409, '본문 또는 계정 권한이 변경됐습니다. 새 오디오북을 만들어 주세요.');
        await client.query('update saved_audiobooks set current_chapter_title=$2 where id=$1', [
          job.id,
          item.chapter_title,
        ]);
        // Reuse a fully saved file left by a crash between atomic rename and the DB commit.
        abort.signal.throwIfAborted();
        const current = (await client.query('select status from saved_audiobooks where id=$1', [job.id])).rows[0];
        if (current?.status !== 'running') throw new DOMException('Stopped', 'AbortError');
        const results = await Promise.allSettled(items.map((next) => this.ensureItem(job, next.ordinal, false, true)));
        const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        // An ambiguous failure must never become an automatic retry just because its sibling hit 429.
        const permanent = failures.find(
          (error) => !(error instanceof BackgroundYield) && this.failure(error).status !== 429,
        );
        if (permanent) throw permanent;
        const limited = failures.filter((error) => this.failure(error).status === 429);
        if (limited.length) {
          const retryAfter = (error: { retryAfterSeconds?: number; payload?: { retryAfterSeconds?: number } }) =>
            error.retryAfterSeconds ?? error.payload?.retryAfterSeconds ?? 0;
          throw limited.reduce((a, b) => (retryAfter(a) >= retryAfter(b) ? a : b));
        }
        await client.query(
          `update saved_audiobooks set error_message=null,retry_at=null,rate_limit_attempts=0,
          status=case when status='pausing' then 'paused' else 'queued' end,updated_at=now()
          where id=$1 and status in ('running','pausing')`,
          [job.id],
        );
        return results.some((result) => result.status === 'fulfilled');
      } catch (error) {
        await client.query('rollback');
        if (this.failure(error).status === 429) {
          if (
            (error as { requestStage?: string; voiceCreationQuota?: number }).requestStage === 'voice_design' &&
            (error as { voiceCreationQuota?: number }).voiceCreationQuota === 0
          ) {
            await client.query(
              `update saved_audiobooks set status=case when status='pausing' then 'paused' else 'failed' end,
               retry_at=null,error_message=$2,updated_at=now() where id=$1 and status in ('running','pausing')`,
              [
                job.id,
                '이 Google Cloud 프로젝트의 목소리 제작 한도가 0이에요. Cloud 콘솔에서 제작 한도와 이용 권한을 확인한 뒤 이어 만들어 주세요.',
              ],
            );
            return false;
          }
          const retryLimit = (error as { analysisRetryLimit?: number }).analysisRetryLimit;
          if (
            Number.isInteger(retryLimit) &&
            retryLimit! >= 0 &&
            retryLimit! <= 100 &&
            job.rate_limit_attempts >= retryLimit!
          ) {
            await client.query(
              `update saved_audiobooks set status=case when status='pausing' then 'paused' else 'failed' end,
              retry_at=null,error_message=case when status='pausing' then null else $2 end,updated_at=now()
              where id=$1 and status in ('running','pausing')`,
              [job.id, '분석 요청 제한의 자동 재시도 횟수를 모두 사용했어요. 설정을 확인한 뒤 이어 만들 수 있어요.'],
            );
            return false;
          }
          const failure = error as { retryAfterSeconds?: number; payload?: { retryAfterSeconds?: number } };
          const hint = failure.retryAfterSeconds ?? failure.payload?.retryAfterSeconds;
          const backoff = Math.min(300, 10 * 2 ** Math.min(job.rate_limit_attempts, 5));
          const seconds = Math.max(
            backoff,
            typeof hint === 'number' && Number.isFinite(hint) ? Math.min(86400, hint) : 0,
          );
          const stage = (error as { requestStage?: string }).requestStage;
          const label =
            stage === 'attribution'
              ? '화자 찾기'
              : stage === 'identity'
                ? '인물 연결'
                : stage === 'voice_design'
                  ? '목소리 제작'
                  : stage === 'voice_selection'
                    ? '목소리 배정'
                    : stage === 'acting'
                      ? '장면 연기 분석'
                      : '음성 제공자';
          await client.query(
            `update saved_audiobooks set
            status=case when status='pausing' then 'paused' else 'queued' end,
            retry_at=now()+($2 * interval '1 second'),rate_limit_attempts=least(rate_limit_attempts+1,100),
            error_message=case when status='pausing' then null else $3 end,updated_at=now()
            where id=$1 and status in ('running','pausing')`,
            [job.id, seconds, `${label} 요청 제한으로 대기 중 · ${Math.ceil(seconds)}초 후 자동으로 이어 만들어요.`],
          );
          return false;
        }
        if (error instanceof BackgroundYield || (abort.signal.aborted && this.closing)) {
          await client.query(
            "update saved_audiobooks set status=case when status='pausing' then 'paused' else 'queued' end where id=$1 and status in ('running','pausing')",
            [job.id],
          );
          return false;
        }
        const message = (error as { statusCode?: number }).statusCode
          ? (error as Error).message
          : this.failure(error).message;
        await client.query(
          `update saved_audiobooks set status=case when status='pausing' then 'paused' else 'failed' end,
          error_message=case when status='pausing' then null else $2 end,updated_at=now() where id=$1 and status in ('running','pausing')`,
          [job.id, message],
        );
        return false;
      } finally {
        this.active = undefined;
      }
    } finally {
      if (locked) await client.query('select pg_advisory_unlock($1::bigint)', [RUNNER_LOCK]);
      client.release();
    }
  }
}
