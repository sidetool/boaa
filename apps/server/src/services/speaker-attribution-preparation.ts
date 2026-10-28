import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { SpeakerEngineInput } from '../../../../src/providers/speaker-engine';
import {
  SPEAKER_ENGINE_PROTOCOL,
  type SpeakerAttributionResult,
  type SpeakerEngineSource,
} from '../../../../src/providers/speaker-engine-protocol';
import type { SpeakerEngineTransport } from '../providers/speaker-engine-transport.js';
import { audiobookError } from './audiobook-plan.js';

/** Separate from the ledger-scoped identity artifacts, but shared across voice variants. */
export const attributionKey = (analysisKey: string) =>
  structuredIntegrityHash({ analysisKey, phase: 'chapter-attribution-v1' });
type Patch = { checkpoint?: unknown; result?: unknown; response?: string };
export async function prepareAttributionBatch(options: {
  pool: pg.Pool;
  owner: string;
  bookId: string;
  analysisKey: string;
  chapterIds: string[];
  autoActing?: boolean;
  identityOnly: readonly string[];
  engine: SpeakerEngineInput;
  transport: SpeakerEngineTransport;
  signal: AbortSignal;
  source(chapterId: string): Promise<SpeakerEngineSource>;
  save(args: unknown[], patch: Patch): Promise<void>;
  active(): Promise<boolean>;
  identity(chapterId: string, active: () => Promise<boolean>): Promise<boolean>;
}) {
  const { pool, owner, bookId, engine, transport, signal } = options;
  const key = attributionKey(options.analysisKey);
  const used = Number(
    (await pool.query('select coalesce(sum(bytes),0) n from speaker_analysis where user_id=$1', [owner])).rows[0].n,
  );
  if (used + options.chapterIds.length * 2 * 1024 * 1024 > 512 * 1024 * 1024)
    throw audiobookError(413, '분석 응답을 저장할 공간이 부족해요.');
  // One bounded window: a finished A frees its slot for ordered B immediately.
  // No replacement A is admitted into that slot until this entire window settles.
  let failed = false;
  const errors: unknown[] = [];
  const active = async () => !failed && !signal.aborted && (await options.active()) && !failed && !signal.aborted;
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  const settle = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      failed = true;
      errors.push(error);
    }
  };
  const ready = options.chapterIds.map((chapterId) =>
    settle(async () => {
      signal.throwIfAborted();
      if (options.identityOnly.includes(chapterId)) return true;
      const source = await options.source(chapterId);
      const args = [owner, bookId, key, chapterId];
      const hash = structuredIntegrityHash(source);
      await pool.query(
        'insert into speaker_analysis(user_id,book_id,analysis_key,chapter_id,input_hash) values($1,$2,$3,$4,$5) on conflict do nothing',
        [...args, hash],
      );
      for (let step = 0; step < 256; step++) {
        if (!(await active())) return false;
        const state = (
          await pool.query(
            'select * from speaker_analysis where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
            args,
          )
        ).rows[0];
        if (state.input_hash !== hash) throw audiobookError(409, '화자를 분석할 본문이 변경됐어요.');
        if (state.result) return true;
        if (Number(state.bytes) + 2 * 1024 * 1024 > 16 * 1024 * 1024)
          throw audiobookError(413, '회차 분석 응답을 저장할 공간이 부족해요.');
        const request = state.checkpoint as Extract<SpeakerAttributionResult, { kind: 'request' }> | null;
        if (!request || state.model_response !== null) {
          let result: SpeakerAttributionResult;
          try {
            result = await transport.attribution(
              engine,
              {
                protocol: SPEAKER_ENGINE_PROTOCOL,
                autoActing: options.autoActing,
                source,
                checkpoint: request?.checkpoint,
                response: state.model_response ?? undefined,
              },
              deadline(),
            );
          } catch (error) {
            if (state.model_response !== null && (error as { upstreamStatus?: number }).upstreamStatus === 422)
              await pool.query(
                'update speaker_analysis set response_rejected=true where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
                args,
              );
            throw error;
          }
          signal.throwIfAborted();
          await options.save(args, result.kind === 'attributed' ? { result } : { checkpoint: result });
          if (result.kind === 'attributed') return true;
          // A new request is prepared without billing on the initial tick.
          if (!request && state.model_response === null) return false;
          continue;
        }
        if (state.dispatching) throw audiobookError(409, '중단된 분석 요청이 있어요. 이어 만들기를 눌러 주세요.');
        if (!(await active())) return false;
        await pool.query(
          'update speaker_analysis set dispatching=true where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
          args,
        );
        let response: string;
        try {
          if (!(await active())) {
            await pool.query(
              'update speaker_analysis set dispatching=false where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
              args,
            );
            return false;
          }
          response = await transport.generate(engine, request, deadline());
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 429)
            await pool.query(
              'update speaker_analysis set dispatching=false where user_id=$1 and book_id=$2 and analysis_key=$3 and chapter_id=$4',
              args,
            );
          throw error;
        }
        // A successful paid sibling survives pause or another sibling's failure; save() fences authority/revision.
        await options.save(args, { response });
      }
      return false;
    }),
  );
  // B waits only for its own A and the prior ledger, never for unrelated siblings.
  const identity = settle(async () => {
    for (let i = 0; i < ready.length; i++) {
      if (!(await ready[i]) || !(await active())) return;
      if (!(await options.identity(options.chapterIds[i], active))) return;
    }
  });
  await Promise.all([...ready, identity]);
  if (errors.length) {
    const failures = errors as { statusCode?: number; retryAfterSeconds?: number }[];
    const uncertain = failures.find((e) => e?.statusCode !== 429);
    if (uncertain) throw uncertain;
    throw Object.assign(
      failures.reduce((a, b) => ((a.retryAfterSeconds ?? 0) >= (b.retryAfterSeconds ?? 0) ? a : b)),
      { analysisRetryLimit: engine.rateLimitRetries },
    );
  }
  signal.throwIfAborted();
}
