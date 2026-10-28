import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSVoices } from '../../../../src/providers/plain-tts';
import {
  PERFORMANCE_INSTRUCTION,
  PERFORMANCE_SCHEMA,
  parsePerformance,
  type SpeakerPerformance,
} from '../../../../src/providers/tts-performance';
import type { SpeakerEngineStore } from '../providers/speaker-engine-store';
import { loadSpeakerChapter, castPlayable, type CastRequest } from './speaker-generation-plan';
import { audiobookError } from './audiobook-plan';

interface ActingRun {
  id: string;
  book_id: string;
  content_revision: string | null;
  settings: AudiobookInput;
  chapter_ids: string[];
}
export async function missingPerformance(pool: pg.Pool, id: string) {
  return !!(
    await pool.query(
      "select 1 from saved_audiobook_items where audiobook_id=$1 and not(request->'cast' ? 'performance') limit 1",
      [id],
    )
  ).rowCount;
}
/** Supplements existing immutable speaker spans; never calls attribution or identity. One bounded request per tick. */
export async function preparePerformance(options: {
  pool: pg.Pool;
  owner: string;
  run: ActingRun;
  engines: SpeakerEngineStore;
  catalog(): Promise<PlainTTSVoices>;
  signal: AbortSignal;
  authority(db?: Pick<pg.Pool, 'query'>, lock?: boolean): Promise<void>;
}) {
  const { pool, owner, run, engines, signal, authority } = options;
  const rows = (
    await pool.query(
      "select ordinal,chapter_id,request,status from saved_audiobook_items where audiobook_id=$1 and not(request->'cast' ? 'performance') order by ordinal limit 32",
      [run.id],
    )
  ).rows as { ordinal: number; chapter_id: string; request: CastRequest; status: string }[];
  if (!rows.length) return true;
  if (rows.some((r) => r.status === 'ready' || r.status === 'dispatching'))
    throw audiobookError(409, '연출을 바꾸려면 음성을 새 작업으로 만들어 주세요.');
  const config = run.settings.cast!.actingEngine;
  if (!config) throw audiobookError(409, '연출 태그를 분석할 모델을 선택해 주세요.');
  const engine = await engines.load(config.id, config.revision);
  if (engine.purpose === 'casting') throw audiobookError(400, '연출에는 화자 분석용 모델을 선택해 주세요.');
  const catalog = await options.catalog();
  for (const row of rows) {
    const v = catalog.voices.find((v) => v.id === row.request.voiceId);
    if (!v?.autoActingSupported || structuredIntegrityHash(v.model) !== structuredIntegrityHash(row.request.cast.model))
      throw audiobookError(409, '자동 연출을 지원하는 목소리 연결을 다시 확인해 주세요.');
  }
  const chapterId = rows[0].chapter_id,
    batch = rows.filter((r) => r.chapter_id === chapterId);
  const loaded = await loadSpeakerChapter(pool, owner, run.book_id, chapterId, run.chapter_ids.indexOf(chapterId) + 1);
  const targets = batch.map((r) => {
    const p = loaded.paragraphs.find((p) => p.id === r.request.paragraphId);
    if (!p) throw audiobookError(409, '본문이 변경됐어요.');
    const playable = castPlayable(p, r.request, run.settings.rules);
    return {
      id: String(r.ordinal),
      speaker: r.request.cast.label,
      text: playable.text,
      context: p.text.slice(Math.max(0, r.request.cast.start - 250), r.request.cast.end + 250).slice(0, 1500),
    };
  });
  const key = 'acting:' + structuredIntegrityHash({ v: 1, engine: config, chapterId, targets });
  const args = [run.id, key];
  await pool.query(
    'insert into speaker_voice_decisions(audiobook_id,decision_key) values($1,$2) on conflict do nothing',
    args,
  );
  const old = (
    await pool.query('select * from speaker_voice_decisions where audiobook_id=$1 and decision_key=$2', args)
  ).rows[0];
  let response = old.response as string | null;
  const active = async () => {
    signal.throwIfAborted();
    await authority();
    return (
      (await pool.query('select status from saved_audiobooks where id=$1', [run.id])).rows[0]?.status === 'running'
    );
  };
  const fenced = async (work: (c: pg.PoolClient) => Promise<void>) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('select id from users where id=$1 for update', [owner]);
      await authority(c, true);
      await engines.load(config.id, config.revision, c);
      await work(c);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  };
  if (!response) {
    if (old.dispatching) throw audiobookError(409, '연출 요청이 중단됐어요. 이어 만들기를 눌러 주세요.');
    if (!(await active())) return false;
    const size = Number(
      (
        await pool.query(
          'select coalesce(sum(octet_length(response)),0) n from speaker_voice_decisions where audiobook_id=$1',
          [run.id],
        )
      ).rows[0].n,
    );
    if (size + 256 * 1024 > 16 * 1024 * 1024) throw audiobookError(413, '연출 응답 저장 한도를 넘었어요.');
    const claimed = await pool.query(
      'update speaker_voice_decisions set dispatching=true where audiobook_id=$1 and decision_key=$2 and not dispatching and response is null returning decision_key',
      args,
    );
    if (!claimed.rowCount) return false;
    try {
      if (!(await active())) {
        await pool.query(
          'update speaker_voice_decisions set dispatching=false where audiobook_id=$1 and decision_key=$2',
          args,
        );
        return false;
      }
      response = await engines.transport.generateJson(
        engine,
        {
          prompt: JSON.stringify({ chapter: loaded.chapter.title, targets }),
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['performance'],
            properties: {
              performance: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'acting'],
                  properties: { id: { type: 'string' }, acting: PERFORMANCE_SCHEMA },
                },
              },
            },
          },
        },
        AbortSignal.any([signal, AbortSignal.timeout(180000)]),
        PERFORMANCE_INSTRUCTION,
      );
      if (Buffer.byteLength(response) > 256 * 1024) throw audiobookError(502, '연출 응답이 너무 커요.');
      await fenced(async (c) => {
        await c.query(
          'update speaker_voice_decisions set response=$3,dispatching=false where audiobook_id=$1 and decision_key=$2',
          [...args, response],
        );
      });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 429) {
        await pool.query(
          'update speaker_voice_decisions set dispatching=false where audiobook_id=$1 and decision_key=$2',
          args,
        );
        Object.assign(e as object, { analysisRetryLimit: engine.rateLimitRetries });
      }
      throw e;
    }
  }
  let values: Map<string, SpeakerPerformance>;
  try {
    const raw = JSON.parse(response!);
    if (
      !raw ||
      Object.keys(raw).length !== 1 ||
      !Array.isArray(raw.performance) ||
      raw.performance.length !== batch.length
    )
      throw Error();
    values = new Map();
    for (const row of raw.performance) {
      if (!row || Object.keys(row).length !== 2 || !targets.some((t) => t.id === row.id) || values.has(row.id))
        throw Error();
      values.set(row.id, parsePerformance(row.acting));
    }
  } catch {
    await pool.query(
      'update speaker_voice_decisions set rejected=true where audiobook_id=$1 and decision_key=$2',
      args,
    );
    throw audiobookError(502, '연출 태그 응답이 올바르지 않아요.');
  }
  if (!(await active())) return false;
  await fenced(async (c) => {
    for (const row of batch) {
      const request = { ...row.request, cast: { ...row.request.cast, performance: values.get(String(row.ordinal))! } };
      const updated = await c.query(
        "update saved_audiobook_items set request=$4 where audiobook_id=$1 and ordinal=$2 and request=$3::jsonb and status not in ('ready','dispatching')",
        [run.id, row.ordinal, row.request, request],
      );
      if (updated.rowCount !== 1) throw audiobookError(409, '연출할 음성 구간이 변경됐어요.');
    }
  });
  return !(await missingPerformance(pool, run.id));
}
