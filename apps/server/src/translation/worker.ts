import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { redisConnectionOptions } from '../queue.js';
import {
  chargeTranslation,
  readTranslationCredential,
  translationIsCurrent,
  withTranslationOwnerTransaction,
  type TranslationRow,
} from './store.js';
import { splitTranslationInput, translateChunk, withTranslationRetry, TranslationError } from './engine.js';
import type { TranslationParagraph } from '../../../../src/translation/contracts.js';
const NAME = 'boaa-translation';
export function createTranslationQueue(config: ServerConfig) {
  return new Queue(NAME, {
    connection: redisConnectionOptions(config),
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 20 },
  });
}
export async function enqueueTranslation(
  queue: Queue,
  row: Pick<TranslationRow, 'id'> & { prefetch?: boolean; kind?: TranslationRow['kind'] },
) {
  const old = await queue.getJob(row.id);
  if (old && ['failed', 'completed'].includes(await old.getState())) await old.remove();
  return queue.add(
    'translate',
    { id: row.id },
    { jobId: row.id, priority: row.prefetch ? 10 : row.kind === 'titles' ? 5 : 1 },
  );
}
export async function recoverTranslations(pool: pg.Pool, queue: Queue) {
  const pending = await pool.query<TranslationRow & { prefetch: boolean }>(
    "select * from translation_jobs where status in ('queued','running') order by prefetch,created_at limit 100",
  );
  for (const row of pending.rows) await enqueueTranslation(queue, row);
}
async function commitOutput(
  pool: pg.Pool,
  row: TranslationRow,
  execution: string,
  output: TranslationParagraph[],
  final = false,
) {
  await withTranslationOwnerTransaction(pool, row.user_id, async (client) => {
    if (row.book_id) await client.query('select pg_advisory_xact_lock(hashtextextended($1,7319))', [row.book_id]);
    if (!(await translationIsCurrent(client, row, execution))) throw new TranslationError('translation_source_changed');
    // Completion and its final output share the owner/book fence and transaction.
    await client.query(
      "update translation_jobs set output=$3,completed=$4,status=case when $5 then 'complete' else status end,execution_id=case when $5 then null else execution_id end,updated_at=now() where id=$1 and execution_id=$2 and status='running'",
      [row.id, execution, JSON.stringify(output), output.length, final],
    );
  });
}
export async function processTranslation(
  pool: pg.Pool,
  config: ServerConfig,
  id: string,
  shutdown: AbortSignal,
  synthesize = translateChunk,
) {
  const execution = randomUUID();
  const claimed = await pool.query<TranslationRow>(
    "update translation_jobs set status='running',execution_id=$2,updated_at=now() where id=$1 and status in ('queued','running') returning *",
    [id, execution],
  );
  const row = claimed.rows[0];
  if (!row) return;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([shutdown, cancellation.signal]);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void translationIsCurrent(pool, row, execution)
      .then(
        (current) => {
          if (!current) cancellation.abort();
        },
        () => cancellation.abort(),
      )
      .finally(() => {
        checking = false;
      });
  }, 2000);
  timer.unref();
  try {
    if (!(await translationIsCurrent(pool, row, execution))) throw new TranslationError('translation_source_changed');
    const credential = await readTranslationCredential(pool, config, row.user_id, row.settings.provider);
    const complete = new Map(row.output.map((p) => [p.id, p]));
    const remaining = row.input.filter((p) => p.text.trim() && !complete.has(p.id));
    const chunks = splitTranslationInput(remaining, row.settings.chunkCharacters);
    const parts = chunks.flat();
    const fragmentsByParagraph = new Map<string, typeof parts>();
    for (const part of parts) {
      const fragments = fragmentsByParagraph.get(part.paragraphId) ?? [];
      fragments.push(part);
      fragmentsByParagraph.set(part.paragraphId, fragments);
    }
    const translated = new Map<string, string>();
    let next = 0;
    let commits = Promise.resolve();
    const run = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const output = await withTranslationRetry(row.settings, signal, async () => {
          signal.throwIfAborted();
          if (!(await translationIsCurrent(pool, row, execution)))
            throw new TranslationError('translation_source_changed');
          await chargeTranslation(
            pool,
            row,
            chunk.reduce((sum, part) => sum + part.text.length, 0),
          );
          return synthesize(row.settings, credential, chunk, signal, row.kind);
        });
        output.forEach((p) => translated.set(p.id, p.text));
        for (const paragraphId of new Set(chunk.map((p) => p.paragraphId))) {
          const fragments = fragmentsByParagraph.get(paragraphId)!;
          if (fragments.every((p) => translated.has(p.id)))
            complete.set(paragraphId, { id: paragraphId, text: fragments.map((p) => translated.get(p.id)).join('') });
        }
        const snapshot = row.input.flatMap((p) => complete.get(p.id) ?? []);
        commits = commits.then(() => commitOutput(pool, row, execution, snapshot));
        await commits;
      }
    };
    // A single chapter owns the queue slot; only its explicitly bounded chunks run concurrently.
    const running = Array.from({ length: Math.min(row.settings.concurrency, chunks.length) }, () =>
      run().catch((error) => {
        cancellation.abort();
        throw error;
      }),
    );
    const results = await Promise.allSettled(running);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    signal.throwIfAborted();
    await commitOutput(
      pool,
      row,
      execution,
      row.input.flatMap((p) => complete.get(p.id) ?? []),
      true,
    );
  } catch (error) {
    const code =
      error instanceof TranslationError
        ? error.code
        : signal.aborted
          ? 'translation_source_changed'
          : 'translation_failed';
    await pool.query(
      "update translation_jobs set status=$3,error_code=$4,execution_id=null,updated_at=now() where id=$1 and execution_id=$2 and status='running'",
      [id, execution, shutdown.aborted ? 'queued' : 'failed', shutdown.aborted ? null : code],
    );
  } finally {
    clearInterval(timer);
  }
}
export function startTranslationWorker(pool: pg.Pool, config: ServerConfig, reportError: () => void) {
  const shutdown = new AbortController();
  const queue = createTranslationQueue(config);
  const worker = new Worker(NAME, (job) => processTranslation(pool, config, job.data.id, shutdown.signal), {
    connection: redisConnectionOptions(config),
    concurrency: 1,
  });
  worker.on('error', reportError);
  let recovery: Promise<void> | undefined;
  const recover = () => {
    recovery ??= recoverTranslations(pool, queue)
      .catch(reportError)
      .finally(() => {
        recovery = undefined;
      });
  };
  recover();
  const timer = setInterval(recover, 30000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      shutdown.abort();
      await recovery;
      await worker.close();
      await queue.close();
    },
  };
}
