import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { AudiobookInput, PreparedNarration } from '../../../../src/providers/plain-audiobook';
import type { SpeakerGenerationInput, SpeakerGenerationJob } from '../../../../src/providers/speaker-generation';
import { SPEAKER_ENGINE_PROTOCOL, type SpeakerEngineResult } from '../../../../src/providers/speaker-engine-protocol';
import type { PlainTTSVoices, PlainTTSModel } from '../../../../src/providers/plain-tts';
import type { SavedAudio } from './audiobook-audio.js';
import { planEpubFootnotePlayback } from '../../../../src/providers/epub-footnote-playback';
import { audiobookError } from './audiobook-plan.js';
import { AudiobookService } from './audiobook-service.js';
import { SpeakerEngineStore } from '../providers/speaker-engine-store.js';
import {
  speakerPlan,
  loadSpeakerChapter,
  castRequests,
  castPlayable,
  type CastRequest,
} from './speaker-generation-plan.js';

interface Run {
  id: string;
  book_id: string;
  content_revision: string | null;
  settings: AudiobookInput;
  status: string;
  analysis_key: string;
  chapter_ids: string[];
  next_chapter: number;
  stage: SpeakerGenerationJob['stage'];
  ledger?: unknown;
  assignments: Record<string, string>;
}
export class SpeakerGenerationService {
  constructor(
    private pool: pg.Pool,
    private owner: string,
    readonly engines: SpeakerEngineStore,
    private audio: AudiobookService,
    private catalog: () => Promise<PlainTTSVoices>,
    private synthesize: (
      text: string,
      voiceId: string,
      model: PlainTTSModel,
      key: string,
      regenerate: boolean,
    ) => Promise<SavedAudio>,
  ) {
    audio.speaker = this;
  }
  private async run(id: string): Promise<Run> {
    const row = (
      await this.pool.query(
        `select a.*,r.analysis_key,r.chapter_ids,r.next_chapter,r.stage,r.ledger,r.assignments from saved_audiobooks a
      join speaker_generation_runs r on r.audiobook_id=a.id join library_books b on b.id=a.book_id
      where a.id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null`,
        [id, this.owner],
      )
    ).rows[0];
    if (!row) throw audiobookError(404, '화자별 생성 작업을 찾을 수 없어요.');
    return row;
  }
  private async authority(run: Run, db: Pick<pg.Pool, 'query'> = this.pool, lock = false) {
    const row = (
      await db.query(
        `select 1 from library_books b join saved_audiobooks a on a.book_id=b.id
      where a.id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null and a.status<>'deleting'
      and b.active_content_revision_id is not distinct from $3::text
      and not exists(select 1 from self_host_accounts where user_id=$2 and (role<>'admin' or status<>'active')) ${lock ? 'for share of b, a' : ''}`,
        [run.id, this.owner, run.content_revision],
      )
    ).rows[0];
    if (!row) throw audiobookError(409, '본문 또는 계정 권한이 변경됐어요. 기존 음성은 보관돼 있어요.');
  }
  /** Commit source-derived artifacts atomically with owner, source, connection and quota checks. */
  private async saveAnalysis(
    run: Run,
    args: unknown[],
    patch: { checkpoint?: unknown; result?: unknown; response?: string },
    stage?: string,
  ) {
    const size = Buffer.byteLength(JSON.stringify(patch));
    if (size > 16 * 1024 * 1024) throw audiobookError(413, '분석 기록이 너무 커요. 생성 범위를 줄여 주세요.');
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      // This owner lock also serializes connection edits and concurrent artifact accounting.
      await c.query('select id from users where id=$1 for update', [this.owner]);
      await this.authority(run, c, true);
      await c.query('select user_id from self_host_accounts where user_id=$1 for share', [this.owner]);
      await this.authority(run, c);
      await this.engines.load(run.settings.cast!.engineId, run.settings.cast!.engineRevision, c);
      if (patch.response !== undefined) {
        await c.query(
          'update speaker_analysis set model_response=$5,dispatching=false,updated_at=now() where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
          [...args, patch.response],
        );
      } else {
        await c.query(
          'update speaker_analysis set checkpoint=$5,result=$6,model_response=null,response_rejected=false,updated_at=now() where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
          [...args, patch.checkpoint ?? null, patch.result ?? null],
        );
      }
      const measured = (
        await c.query(
          `update speaker_analysis set bytes=octet_length(coalesce(checkpoint::text,''))+octet_length(coalesce(result::text,''))+octet_length(coalesce(model_response,''))
        where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4 returning bytes`,
          args,
        )
      ).rows[0];
      if (!measured || Number(measured.bytes) > 16 * 1024 * 1024)
        throw audiobookError(413, '분석 기록이 너무 커요. 생성 범위를 줄여 주세요.');
      const total = Number(
        (await c.query('select coalesce(sum(bytes),0) n from speaker_analysis where user_id=$1', [this.owner])).rows[0]
          .n,
      );
      if (total > 512 * 1024 * 1024)
        throw audiobookError(413, '화자 분석 저장 공간이 가득 찼어요. 필요 없는 생성 작업을 삭제해 주세요.');
      if (stage) await c.query('update speaker_generation_runs set stage=$2 where audiobook_id=$1', [run.id, stage]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async remove(id: string) {
    const run = await this.run(id);
    await this.audio.remove(id);
    // Other voice variants may still depend on these reusable analysis artifacts.
    await this.pool.query(
      `delete from speaker_analysis s where s.user_id=$1 and s.book_id=$2 and s.analysis_key=$3
      and not exists(select 1 from speaker_generation_runs r join saved_audiobooks a on a.id=r.audiobook_id where a.user_id=s.user_id and a.book_id=s.book_id and r.analysis_key=s.analysis_key)`,
      [this.owner, run.book_id, run.analysis_key],
    );
  }
  async list(bookId: string): Promise<SpeakerGenerationJob[]> {
    const rows = (
      await this.pool.query(
        `select a.*,r.next_chapter,r.chapter_ids as context_ids,r.stage,
      coalesce((select jsonb_agg(distinct i.chapter_id) from saved_audiobook_items i where i.audiobook_id=a.id and i.status='ready'),'[]') ready_ids
      from saved_audiobooks a join speaker_generation_runs r on r.audiobook_id=a.id join library_books b on b.id=a.book_id
      where a.book_id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null order by a.created_at desc limit 50`,
        [bookId, this.owner],
      )
    ).rows;
    return rows.map((r) => ({
      ...r.estimate,
      id: r.id,
      bookId: r.book_id,
      chapterIds: r.settings.chapterIds,
      title: r.title,
      status: r.status,
      completedItems: r.completed_items,
      bytes: Number(r.bytes),
      playbackIndex: r.playback_index,
      currentChapterTitle: r.current_chapter_title ?? undefined,
      error: r.error_message ?? undefined,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      stage: r.status === 'completed' ? 'complete' : r.stage,
      analyzedChapters: r.next_chapter,
      contextChapterCount: r.context_ids.length - r.settings.chapterIds.length,
      readyChapterIds: r.ready_ids,
    }));
  }
  async estimate(bookId: string, input: SpeakerGenerationInput) {
    return (await speakerPlan(this.pool, this.owner, bookId, input, await this.catalog(), this.engines)).estimate;
  }
  async create(bookId: string, input: SpeakerGenerationInput, fingerprint: string, paid: boolean) {
    const { plan } = await speakerPlan(this.pool, this.owner, bookId, input, await this.catalog(), this.engines);
    const job = await this.audio.create(plan, fingerprint, paid);
    return (await this.list(bookId)).find((j) => j.id === job.id)!;
  }
  async resume(id: string) {
    const run = await this.run(id);
    if (!['paused', 'failed'].includes(run.status)) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const lock = `speaker:${this.owner}:${run.book_id}:${run.analysis_key}`;
      if (
        !(await client.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', [lock])).rows[0].locked
      )
        throw audiobookError(409, '분석 요청이 마무리되고 있어요. 잠시 후 이어 만들어 주세요.');
      await client.query(
        `update speaker_analysis set dispatching=false,bytes=case when response_rejected then octet_length(coalesce(checkpoint::text,''))+octet_length(coalesce(result::text,'')) else bytes end,model_response=case when response_rejected then null else model_response end,response_rejected=false
        where user_id=$1 and book_id=$2 and analysis_key=$3 and result is null`,
        [this.owner, run.book_id, run.analysis_key],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  async advance(id: string, signal: AbortSignal) {
    const run = await this.run(id);
    await this.authority(run);
    if (
      (
        await this.pool.query("select 1 from saved_audiobook_items where audiobook_id=$1 and status<>'ready' limit 1", [
          id,
        ])
      ).rowCount
    )
      return;
    if (run.next_chapter >= run.chapter_ids.length) {
      await this.pool.query('update saved_audiobooks set planning_complete=true where id=$1', [id]);
      return;
    }
    const client = await this.pool.connect();
    const lock = `speaker:${this.owner}:${run.book_id}:${run.analysis_key}`;
    let locked = false;
    try {
      locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) locked', [lock])).rows[0]
        .locked;
      if (!locked) return;
      const chapterId = run.chapter_ids[run.next_chapter];
      const loaded = await loadSpeakerChapter(this.pool, this.owner, run.book_id, chapterId, run.next_chapter + 1);
      const all = (
        await this.pool.query('select id from chapters where book_id=$1 order by chapter_index,id', [run.book_id])
      ).rows;
      const side = async (n: number) =>
        n >= 0 && n < all.length
          ? (await loadSpeakerChapter(this.pool, this.owner, run.book_id, all[n].id, n + 1)).chapter
          : undefined;
      const source = {
        scope: run.book_id,
        revision: run.content_revision ?? structuredIntegrityHash(run.book_id),
        chapter: loaded.chapter,
        previous: await side(run.next_chapter - 1),
        next: await side(run.next_chapter + 1),
      };
      const inputHash = structuredIntegrityHash({ source, ledger: run.ledger ?? null });
      const args = [this.owner, run.book_id, run.analysis_key, chapterId];
      await client.query(
        'insert into speaker_analysis(user_id,book_id,analysis_key,chapter_id,input_hash) values($1,$2,$3,$4,$5) on conflict do nothing',
        [...args, inputHash],
      );
      const state = (
        await client.query(
          'select * from speaker_analysis where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
          args,
        )
      ).rows[0];
      if (state.input_hash !== inputHash)
        throw audiobookError(409, '이전 회차의 분석 기록이 달라졌어요. 새 작업으로 만들어 주세요.');
      if (state.result) {
        await this.acceptChapter(run, loaded, state.result);
        return;
      }
      const config = run.settings.cast!;
      const engine = await this.engines.load(config.engineId, config.engineRevision);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      const caps = await this.engines.transport.capabilities(engine, deadline);
      if (caps.engineVersion !== config.engineVersion)
        throw audiobookError(409, '분석 엔진 버전이 바뀌었어요. 기존 결과를 보관하고 새 작업으로 시작해 주세요.');
      const request = state.checkpoint as Extract<SpeakerEngineResult, { kind: 'request' }> | null;
      await client.query('update saved_audiobooks set current_chapter_title=$2 where id=$1', [
        id,
        loaded.chapter.title,
      ]);
      if (!request || state.model_response !== null) {
        let result: SpeakerEngineResult;
        try {
          result = await this.engines.transport.step(
            engine,
            {
              protocol: SPEAKER_ENGINE_PROTOCOL,
              source,
              ledger: run.ledger ?? undefined,
              checkpoint: request?.checkpoint,
              response: state.model_response ?? undefined,
            },
            deadline,
          );
        } catch (e) {
          if (state.model_response !== null && (e as { upstreamStatus?: number }).upstreamStatus === 422)
            await client.query(
              'update speaker_analysis set response_rejected=true where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
              args,
            );
          throw e;
        }
        signal.throwIfAborted();
        await this.saveAnalysis(
          run,
          args,
          {
            checkpoint: result.kind === 'request' ? result : undefined,
            result: result.kind === 'complete' ? result : undefined,
          },
          result.kind === 'request' ? result.stage : 'audio',
        );
      } else {
        if (state.dispatching) throw audiobookError(409, '중단된 분석 요청이 있어요. 이어 만들기를 눌러 주세요.');
        await client.query('update speaker_generation_runs set stage=$2 where audiobook_id=$1', [id, request.stage]);
        signal.throwIfAborted();
        const used = Number(
          (await client.query('select coalesce(sum(bytes),0) n from speaker_analysis where user_id=$1', [this.owner]))
            .rows[0].n,
        );
        if (used + 2 * 1024 * 1024 > 512 * 1024 * 1024 || Number(state.bytes) + 2 * 1024 * 1024 > 16 * 1024 * 1024)
          throw audiobookError(413, '분석 응답을 저장할 공간이 부족해요. 필요 없는 생성 작업을 삭제해 주세요.');
        await client.query(
          'update speaker_analysis set dispatching=true where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
          args,
        );
        let response: string;
        try {
          response = await this.engines.transport.generate(engine, request, deadline);
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 429)
            await client.query(
              'update speaker_analysis set dispatching=false where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
              args,
            );
          throw e;
        }
        // Save completed model output even if the user paused; acceptance happens only after ownership validation.
        await this.saveAnalysis(run, args, { response });
      }
    } finally {
      if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [lock]);
      client.release();
    }
  }
  private async acceptChapter(
    run: Run,
    loaded: Awaited<ReturnType<typeof loadSpeakerChapter>>,
    result: Extract<SpeakerEngineResult, { kind: 'complete' }>,
  ) {
    if (
      !result.identities.every(
        (i) =>
          typeof i.id === 'string' &&
          /^[a-zA-Z0-9:_-]{1,256}$/.test(i.id) &&
          !['__proto__', 'constructor', 'prototype'].includes(i.id) &&
          typeof i.name === 'string' &&
          i.name.length <= 200,
      ) ||
      new Set(result.identities.map((i) => i.id)).size !== result.identities.length
    )
      throw audiobookError(502, '인물 분석 결과가 올바르지 않아요.');
    const sourceIds = new Set(loaded.paragraphs.map((p) => p.id));
    if (result.labels.some((l) => !sourceIds.has(l.paragraphId)))
      throw audiobookError(502, '분석 결과에 다른 문단이 포함됐어요.');
    const assignments = { ...run.assignments };
    const choices = run.settings.cast!.characterVoiceIds;
    for (const i of result.identities)
      if (!Object.hasOwn(assignments, i.id))
        assignments[i.id] = choices[Object.keys(assignments).length % choices.length];
    castRequests(loaded.paragraphs, result.labels, result.identities, assignments, run.settings);
    const selected = run.settings.chapterIds.includes(loaded.chapter.id);
    const ps = planEpubFootnotePlayback({
      paragraphs: loaded.paragraphs,
      startIndex: 0,
      policy: run.settings.footnotePlayback,
    }).paragraphs;
    const ids = new Set(ps.map((p) => p.id));
    const requests = selected
      ? castRequests(
          ps,
          result.labels.filter((l) => ids.has(l.paragraphId)),
          result.identities,
          assignments,
          run.settings,
        )
      : [];
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('select user_id from self_host_accounts where user_id=$1 for share', [this.owner]);
      const job = (
        await c.query(
          `select a.total_items from saved_audiobooks a join library_books b on b.id=a.book_id
        where a.id=$1 and a.user_id=$2 and a.status in ('running','pausing') and b.user_id=$2 and b.deleted_at is null
        and not exists(select 1 from self_host_accounts where user_id=$2 and (role<>'admin' or status<>'active'))
        and b.active_content_revision_id is not distinct from $3::text for update of a for share of b`,
          [run.id, this.owner, run.content_revision],
        )
      ).rows[0];
      if (!job) throw audiobookError(409, '생성할 본문이나 작업이 변경됐어요.');
      if (
        (await c.query('select next_chapter from speaker_generation_runs where audiobook_id=$1 for update', [run.id]))
          .rows[0]?.next_chapter !== run.next_chapter
      )
        throw audiobookError(409, '회차 분석이 이미 진행됐어요.');
      const total = job.total_items + requests.length;
      if (total > 100000) throw audiobookError(413, '생성 구간이 너무 많아요.');
      for (let start = 0; start < requests.length; start += 250) {
        const batch = requests
          .slice(start, start + 250)
          .map((request, index) => ({ ordinal: job.total_items + start + index, request }));
        await c.query(
          `insert into saved_audiobook_items(audiobook_id,ordinal,chapter_id,chapter_title,request)
          select $1,x.ordinal,$2,$3,x.request from jsonb_to_recordset($4::jsonb) x(ordinal int,request jsonb)`,
          [run.id, loaded.chapter.id, loaded.chapter.title, JSON.stringify(batch)],
        );
      }
      await c.query(
        `update saved_audiobooks set total_items=$2,estimate=jsonb_set(estimate,'{itemCount}',to_jsonb($2::int)),planning_complete=$3 where id=$1`,
        [run.id, total, run.next_chapter + 1 === run.chapter_ids.length],
      );
      await c.query(
        "update speaker_generation_runs set next_chapter=next_chapter+1,ledger=$2,assignments=$3,stage='audio' where audiobook_id=$1 and next_chapter=$4",
        [run.id, result.ledger, assignments, run.next_chapter],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async reader(id: string, chapterId: string): Promise<PreparedNarration> {
    const run = await this.run(id);
    await this.authority(run);
    const loaded = await loadSpeakerChapter(
      this.pool,
      this.owner,
      run.book_id,
      chapterId,
      run.chapter_ids.indexOf(chapterId) + 1,
    );
    const rows = (
      await this.pool.query(
        'select * from saved_audiobook_items where audiobook_id=$1 and chapter_id=$2 order by ordinal',
        [id, chapterId],
      )
    ).rows;
    if (!rows.length) throw audiobookError(425, '이 회차의 화자를 분석하고 있어요. 준비된 회차부터 들을 수 있어요.');
    const byId = new Map(loaded.paragraphs.map((p) => [p.id, p]));
    return {
      id,
      chapterId,
      contentRevision: run.content_revision ?? undefined,
      voiceLabel: '화자별 목소리',
      items: rows.map((r) => {
        const p = byId.get(r.request.paragraphId);
        if (!p) throw audiobookError(409, '본문이 변경됐어요.');
        return {
          ordinal: r.ordinal,
          paragraphIndex: p.index - 1,
          nextParagraphIndex: p.index,
          playable: {
            ...castPlayable(p, r.request, run.settings.rules),
            preparedAudio: { id, ordinal: r.ordinal, ready: r.status === 'ready' },
          },
        };
      }),
    };
  }
  async render(id: string, ordinal: number, regenerate: boolean): Promise<SavedAudio> {
    const run = await this.run(id);
    await this.authority(run);
    const row = (
      await this.pool.query(
        'select chapter_id,request from saved_audiobook_items where audiobook_id=$1 and ordinal=$2',
        [id, ordinal],
      )
    ).rows[0];
    if (!row) throw audiobookError(404, '낭독 구간을 찾지 못했어요.');
    const loaded = await loadSpeakerChapter(
      this.pool,
      this.owner,
      run.book_id,
      row.chapter_id,
      run.chapter_ids.indexOf(row.chapter_id) + 1,
    );
    const request = row.request as CastRequest;
    const p = loaded.paragraphs.find((p) => p.id === request.paragraphId);
    if (!p) throw audiobookError(409, '본문이 변경됐어요.');
    const playable = castPlayable(p, request, run.settings.rules);
    const key = structuredIntegrityHash({
      v: 'cast-prepared-1',
      user: this.owner,
      book: run.book_id,
      revision: run.content_revision,
      chapter: row.chapter_id,
      request,
      text: playable.text,
    });
    const audio = await this.synthesize(playable.text, request.voiceId, request.cast.model, key, regenerate);
    await this.authority(run);
    return audio;
  }
}
