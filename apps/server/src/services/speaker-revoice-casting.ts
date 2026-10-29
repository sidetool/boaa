import { applyBookVoiceUpdates } from './speaker-book-voices';
import { textIntegrityHash } from '@boaa/text-core/hash';
import type pg from 'pg';
import type { SpeakerEngineResult } from '../../../../src/providers/speaker-engine-protocol';
import type { SpeakerVoiceCasting, CastingRun } from './speaker-voice-casting';
import { loadSpeakerChapter, castPlayable, unbatchCastRequest, type CastRequest } from './speaker-generation-plan';
import { audiobookError } from './audiobook-plan';

/** Recast only captured spans in a new audio variant; never alters analysis or book bindings. */
export async function prepareRevoiceCasting(options: {
  pool: pg.Pool;
  owner: string;
  run: CastingRun;
  casting: SpeakerVoiceCasting;
  signal: AbortSignal;
  authority(db?: Pick<pg.Pool, 'query'>, lock?: boolean): Promise<void>;
}) {
  const { pool, owner, run, casting, signal, authority } = options;
  const pending = run.settings.cast!.recastSpeakers ?? [];
  if (!pending.length) return true;
  const rows = (
    await pool.query(
      `select distinct on (request->'cast'->>'speakerId') chapter_id,request
     from saved_audiobook_items where audiobook_id=$1 and request->'cast'->>'speakerId'=any($2::text[])
     order by request->'cast'->>'speakerId',ordinal limit 8`,
      [run.id, pending],
    )
  ).rows as { chapter_id: string; request: CastRequest }[];
  if (!rows.length) throw audiobookError(409, '새 목소리를 만들 인물의 음성 구간이 없어요.');
  const chapterId = rows[0].chapter_id;
  const batch = rows.filter((r) => r.chapter_id === chapterId);
  const loaded = await loadSpeakerChapter(
    pool,
    owner,
    run.book_id,
    chapterId,
    run.settings.chapterIds.indexOf(chapterId) + 1,
  );
  const evidence = (
    await pool.query(
      `select request from (select request,row_number() over(partition by request->'cast'->>'speakerId' order by ordinal) n
     from saved_audiobook_items where audiobook_id=$1 and chapter_id=$2 and request->'cast'->>'speakerId'=any($3::text[])) examples
     where n<=3 order by request->'cast'->>'speakerId',n`,
      [run.id, chapterId, batch.map((r) => r.request.cast.speakerId)],
    )
  ).rows as { request: CastRequest }[];
  const result: Extract<SpeakerEngineResult, { kind: 'complete' }> = {
    kind: 'complete',
    ledger: {},
    identities: batch.map(({ request: r }) => ({ id: r.cast.speakerId, name: r.cast.label, reviewRequired: false })),
    labels: evidence
      .flatMap(({ request }) => unbatchCastRequest(request))
      .map((r) => {
        const paragraph = loaded.paragraphs.find((p) => p.id === r.paragraphId);
        if (!paragraph) throw audiobookError(409, '본문이 변경됐어요.');
        castPlayable(paragraph, r, run.settings.rules);
        return {
          paragraphId: r.paragraphId,
          startOffset: r.cast.start,
          endOffset: r.cast.end,
          textHash: textIntegrityHash(paragraph.text.slice(r.cast.start, r.cast.end)),
          speakerId: r.cast.speakerId,
          reviewRequired: false,
        };
      }),
  };
  const selected = await casting.select({ ...run, assignments: {} }, loaded.chapter, result, signal, run.assignments);
  if (!selected) return false;
  signal.throwIfAborted();
  const done = result.identities.map((i) => i.id);
  const remaining = pending.filter((id) => !done.includes(id));
  const c = await pool.connect();
  try {
    await c.query('begin');
    await casting.library.authority(c, true);
    await authority(c, true);
    const job = (await c.query('select status,settings from saved_audiobooks where id=$1 for update', [run.id]))
      .rows[0];
    if (job?.status !== 'running') {
      await c.query('rollback');
      return false;
    }
    if (JSON.stringify(job.settings.cast.recastSpeakers) !== JSON.stringify(pending))
      throw audiobookError(409, '새 목소리 작업이 변경됐어요.');
    for (const id of done) {
      const voiceId = selected.assignments[id],
        model = selected.models[voiceId];
      await casting.library.source(model.providerId, model);
      const busy = await c.query(
        "select 1 from saved_audiobook_items where audiobook_id=$1 and request->'cast'->>'speakerId'=$2 and status in ('ready','dispatching') limit 1",
        [run.id, id],
      );
      if (busy.rowCount) throw audiobookError(409, '이미 생성된 음성은 새 작업에서 바꿔 주세요.');
      await c.query(
        `update saved_audiobook_items set request=jsonb_set(jsonb_set(request,'{voiceId}',to_jsonb($3::text)),'{cast,model}',$4::jsonb)
         where audiobook_id=$1 and request->'cast'->>'speakerId'=$2`,
        [run.id, id, voiceId, JSON.stringify(model)],
      );
    }
    if (run.settings.cast?.applyToBook)
      await applyBookVoiceUpdates(
        c,
        owner,
        run.book_id,
        run.analysis_key,
        done.map((id) => ({
          speakerId: id,
          name: result.identities.find((i) => i.id === id)!.name,
          voiceId: selected.assignments[id],
          model: selected.models[selected.assignments[id]],
        })),
        run.settings.cast.bookVoiceVersions ?? {},
      );
    const settings = {
      ...run.settings,
      cast: { ...run.settings.cast!, models: selected.models, recastSpeakers: remaining },
    };
    await c.query('update saved_audiobooks set settings=$2 where id=$1', [run.id, settings]);
    await c.query('update speaker_generation_runs set assignments=$2 where audiobook_id=$1', [
      run.id,
      { ...run.assignments, ...selected.assignments },
    ]);
    await c.query("delete from speaker_voice_decisions where audiobook_id=$1 and decision_key not like 'acting:%'", [
      run.id,
    ]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return remaining.length === 0;
}
