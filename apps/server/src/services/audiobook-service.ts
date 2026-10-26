import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AudiobookInput, SavedAudiobook } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSRequest, PlainTTSVoices } from '../../../../src/providers/plain-tts';
import { requestPlainTTSWithRetry } from '../../../../src/providers/plain-tts-retry';
import { AudiobookAudioStore, type SavedAudio } from './audiobook-audio.js';
import { audiobookError, planAudiobook, type AudiobookPlan } from './audiobook-plan.js';

const RUNNER_LOCK = '61879419263191';
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
    title: row.title,
    status: row.status,
    completedItems: row.completed_items,
    bytes: Number(row.bytes),
    playbackIndex: row.playback_index,
    currentChapterTitle: row.current_chapter_title ?? undefined,
    error: row.error_message ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class AudiobookService {
  private active?: { id: string; abort: AbortController };
  private lastCleanup = 0;
  private closing = false;
  async stop() {
    this.closing = true;
    if (this.active) {
      this.active.abort.abort();
      await this.pool.query(
        "update saved_audiobooks set status='pausing' where id=$1 and user_id=$2 and status='running'",
        [this.active.id, this.owner],
      );
    }
  }
  constructor(
    private readonly pool: pg.Pool,
    private readonly owner: string,
    readonly audioStore: AudiobookAudioStore,
    private readonly catalog: () => Promise<PlainTTSVoices>,
    private readonly render: (chapterId: string, request: PlainTTSRequest) => Promise<SavedAudio>,
    private readonly failure: (error: unknown) => { message: string; status: number },
  ) {}

  async plan(bookId: string, settings: AudiobookInput) {
    return planAudiobook(this.pool, this.owner, bookId, settings, await this.catalog());
  }
  async list(bookId: string): Promise<SavedAudiobook[]> {
    return (
      await this.pool.query(
        `select a.* from saved_audiobooks a join library_books b on b.id=a.book_id
      where a.book_id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null order by a.created_at desc limit 50`,
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
  async create(plan: AudiobookPlan, fingerprint: string, confirmPaid: boolean): Promise<SavedAudiobook> {
    if (fingerprint !== plan.estimate.fingerprint)
      throw audiobookError(409, '본문 또는 생성 범위가 변경됐습니다. 다시 확인해 주세요.');
    if (plan.estimate.paid && !confirmPaid) throw audiobookError(400, 'API 사용 비용을 확인한 뒤 시작해 주세요.');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`audiobook:${this.owner}`]);
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
      const id = randomUUID();
      const row = (
        await client.query(
          `insert into saved_audiobooks(id,user_id,book_id,content_revision,fingerprint,title,settings,estimate,status,total_items)
        values($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) returning *`,
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
          ],
        )
      ).rows[0];
      // Send bounded batches to PostgreSQL; requests contain source hashes, never raw book text.
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
      if (this.active?.id === id) this.active.abort.abort();
    } else if (action === 'resume') {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const row = (
          await client.query(
            `update saved_audiobooks set status='queued',error_message=null,updated_at=now()
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
      and status not in ('running','pausing') returning id`,
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
    if (job.status === 'deleting' || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= job.completed_items)
      throw audiobookError(404, '아직 저장되지 않은 음성입니다.');
    const audio = await this.audioStore.get(id, ordinal);
    if (!audio) throw audiobookError(410, '저장된 음성 파일이 없거나 손상됐습니다. 오디오북을 다시 만들어 주세요.');
    return audio;
  }
  async progress(id: string, index: number) {
    const job = await this.get(id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= job.completed_items)
      throw audiobookError(400, '재생 위치가 올바르지 않습니다.');
    await this.pool.query('update saved_audiobooks set playback_index=$2 where id=$1 and user_id=$3', [
      id,
      index,
      this.owner,
    ]);
  }

  /** One durable item per turn. A session advisory lock fences multiple API processes without a long DB transaction. */
  async tick(): Promise<void> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('select pg_try_advisory_lock($1::bigint) as locked', [RUNNER_LOCK])).rows[0].locked;
      if (!locked || this.closing) return;
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
        where id=(select id from saved_audiobooks where user_id=$1 and status='queued' order by updated_at,id limit 1) and status='queued' returning *`,
          [this.owner],
        )
      ).rows[0] as JobRow | undefined;
      if (!job) return;
      if (this.closing) {
        await client.query("update saved_audiobooks set status='queued' where id=$1 and status='running'", [job.id]);
        return;
      }
      const abort = new AbortController();
      this.active = { id: job.id, abort };
      try {
        const item = (
          await client.query(
            "select * from saved_audiobook_items where audiobook_id=$1 and status<>'ready' order by ordinal limit 1",
            [job.id],
          )
        ).rows[0];
        if (!item) throw new Error('audiobook_missing_item');
        const authority = (
          await client.query(
            `select b.id from library_books b where b.id=$1 and b.user_id=$2 and b.deleted_at is null
          and b.active_content_revision_id is not distinct from $3::text
          and not exists(select 1 from self_host_accounts a where a.user_id=$2 and (a.role<>'admin' or a.status<>'active'))`,
            [job.book_id, this.owner, job.content_revision],
          )
        ).rows[0];
        if (!authority) throw audiobookError(409, '본문 또는 계정 권한이 변경됐습니다. 새 오디오북을 만들어 주세요.');
        const usage = Number(
          (
            await client.query('select coalesce(sum(bytes),0) as bytes from saved_audiobooks where user_id=$1', [
              this.owner,
            ])
          ).rows[0].bytes,
        );
        if (usage + 16 * 1024 * 1024 > AUDIOBOOK_QUOTA_BYTES)
          throw audiobookError(409, '오디오북 저장 공간이 가득 찼습니다. 일부를 삭제한 뒤 이어 만들어 주세요.');
        await client.query('update saved_audiobooks set current_chapter_title=$2 where id=$1', [
          job.id,
          item.chapter_title,
        ]);
        await client.query(
          "update saved_audiobook_items set status='dispatching' where audiobook_id=$1 and ordinal=$2",
          [job.id, item.ordinal],
        );
        // Reuse a fully saved file left by a crash between atomic rename and the DB commit.
        const audio =
          (await this.audioStore.get(job.id, item.ordinal)) ??
          (await requestPlainTTSWithRetry(
            async () => {
              const current = (await client.query('select status from saved_audiobooks where id=$1', [job.id])).rows[0];
              if (current?.status !== 'running') {
                abort.abort();
                abort.signal.throwIfAborted();
              }
              try {
                return await this.render(item.chapter_id, { ...item.request, rules: job.settings.rules });
              } catch (error) {
                const retry = error as { status?: number; retryAfterSeconds?: number };
                if (retry?.status === 429 && typeof retry.retryAfterSeconds === 'number')
                  throw Object.assign(new Error('음성 제공자의 요청 제한이 풀리기를 기다리고 있습니다.'), {
                    status: 429,
                    payload: { retryAfterSeconds: retry.retryAfterSeconds },
                  });
                throw error;
              }
            },
            {
              signal: abort.signal,
              onWait: (seconds) => {
                void this.pool
                  .query("update saved_audiobooks set error_message=$2 where id=$1 and status='running'", [
                    job.id,
                    `음성 제공자 대기 중 · ${Math.ceil(seconds)}초 후 다시 시도`,
                  ])
                  .catch(() => {});
              },
            },
          ));
        await this.audioStore.put(job.id, item.ordinal, audio);
        await client.query('begin');
        const owned = (
          await client.query(
            `select b.id from library_books b where b.id=$1 and b.user_id=$2 and b.deleted_at is null
          and b.active_content_revision_id is not distinct from $3::text for share`,
            [job.book_id, this.owner, job.content_revision],
          )
        ).rows[0];
        if (!owned) throw audiobookError(409, '생성 중 본문이 변경되어 멈췄습니다.');
        await client.query(
          "update saved_audiobook_items set status='ready',cache_key=$3,bytes=$4 where audiobook_id=$1 and ordinal=$2",
          [job.id, item.ordinal, audio.key, audio.data.length],
        );
        await client.query(
          `update saved_audiobooks set completed_items=completed_items+1,bytes=bytes+$2,error_message=null,
          status=case when completed_items+1=total_items then 'completed' when status='pausing' then 'paused' else 'queued' end,updated_at=now() where id=$1`,
          [job.id, audio.data.length],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        const message = (error as { statusCode?: number }).statusCode
          ? (error as Error).message
          : this.failure(error).message;
        await client.query(
          `update saved_audiobooks set status=case when status='pausing' then 'paused' else 'failed' end,
          error_message=case when status='pausing' then null else $2 end,updated_at=now() where id=$1`,
          [job.id, message],
        );
      } finally {
        this.active = undefined;
      }
    } finally {
      if (locked) await client.query('select pg_advisory_unlock($1::bigint)', [RUNNER_LOCK]);
      client.release();
    }
  }
}
