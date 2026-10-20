import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Queue } from 'bullmq';
import type { ServerConfig } from '../config.js';
import { requireAdmin } from '../auth.js';
import { validateTranslationSettings, type TranslationRequest } from '../../../../src/translation/contracts.js';
import {
  presentTranslation,
  translationSourceCurrentSql,
  requestTranslation,
  saveTranslationCredential,
  translationConfiguration,
  withTranslationOwnerTransaction,
  type TranslationRow,
} from './store.js';
import { enqueueTranslation } from './worker.js';
import { TranslationError } from './engine.js';
import { requestTitleTranslations } from './titles.js';

export async function registerTranslationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue,
) {
  await app.register(async (routes) => {
    // Translation credentials and costs initially belong to the administrator only.
    routes.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireAdmin(request);
    });
    routes.setErrorHandler((error, _request, reply) => {
      const code =
        error instanceof TranslationError
          ? error.code
          : error instanceof Error && error.message.startsWith('translation_')
            ? error.message
            : 'translation_failed';
      const status = (error as { statusCode?: number }).statusCode;
      return reply
        .code(
          status && status >= 400 && status < 500
            ? status
            : code === 'translation_conflict' || code === 'translation_source_changed'
              ? 409
              : 400,
        )
        .send({ error: code });
    });
    routes.get('/api/translation/settings', (request) => translationConfiguration(pool, requireAdmin(request).userId));
    routes.put<{ Body: { settings: unknown; revision: number } }>('/api/translation/settings', async (request) => {
      const owner = requireAdmin(request).userId;
      const settings = validateTranslationSettings(request.body?.settings);
      await withTranslationOwnerTransaction(pool, owner, async (client) => {
        const current = await translationConfiguration(client, owner);
        if (current.revision !== request.body.revision) throw new TranslationError('translation_conflict');
        await client.query(
          `insert into translation_settings(user_id,settings) values($1,$2) on conflict(user_id) do update set settings=excluded.settings,revision=translation_settings.revision+1,updated_at=now()`,
          [owner, settings],
        );
        const chapterChanged = (Object.keys(settings) as Array<keyof typeof settings>).some(
          (key) => key !== 'translateTitles' && settings[key] !== current.settings[key],
        );
        await client.query(
          "update translation_jobs set status='cancelled',execution_id=null,updated_at=now() where user_id=$1 and status in ('queued','running') and ($2::boolean or kind='titles')",
          [owner, chapterChanged],
        );
      });
      return translationConfiguration(pool, owner);
    });
    routes.put<{ Params: { provider: string }; Body: { value: string } }>(
      '/api/translation/credentials/:provider',
      { bodyLimit: 100000 },
      async (request) => {
        if (typeof request.body?.value !== 'string') throw new TranslationError('translation_invalid_settings');
        const owner = requireAdmin(request).userId;
        await withTranslationOwnerTransaction(pool, owner, async (client) => {
          await saveTranslationCredential(client, config, owner, request.params.provider, request.body.value);
          await client.query(
            "update translation_jobs set status='cancelled',execution_id=null,updated_at=now() where user_id=$1 and settings->>'provider'=$2 and status in ('queued','running')",
            [owner, request.params.provider],
          );
        });
        return { saved: true };
      },
    );
    routes.delete<{ Params: { provider: string } }>('/api/translation/credentials/:provider', async (request) => {
      const owner = requireAdmin(request).userId;
      await withTranslationOwnerTransaction(pool, owner, async (client) => {
        await client.query('delete from translation_credentials where user_id=$1 and provider=$2', [
          owner,
          request.params.provider,
        ]);
        await client.query(
          "update translation_jobs set status='cancelled',execution_id=null,updated_at=now() where user_id=$1 and settings->>'provider'=$2 and status in ('queued','running')",
          [owner, request.params.provider],
        );
      });
      return { saved: false };
    });
    routes.post<{ Body: { titles: unknown } }>('/api/translation/titles', { bodyLimit: 50000 }, async (request) => {
      const { response, queued } = await requestTitleTranslations(
        pool,
        requireAdmin(request).userId,
        request.body?.titles,
      );
      for (const row of queued) await enqueueTranslation(queue, row);
      return response;
    });
    routes.post<{ Body: TranslationRequest }>('/api/translation/jobs', { bodyLimit: 3000000 }, async (request) => {
      const row = await requestTranslation(pool, requireAdmin(request).userId, request.body);
      if (row?.status === 'queued' && !request.body.lookupOnly)
        await enqueueTranslation(queue, { ...row, prefetch: request.body.prefetch });
      return { result: row ? presentTranslation(row) : null };
    });
    routes.get<{ Params: { id: string } }>('/api/translation/jobs/:id', async (request, reply) => {
      const result = await pool.query<TranslationRow>(
        `select j.* from translation_jobs j where j.id=$1 and j.user_id=$2 and ${translationSourceCurrentSql}`,
        [request.params.id, requireAdmin(request).userId],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'translation_source_changed' });
      return presentTranslation(result.rows[0]);
    });
    routes.delete<{ Params: { id: string } }>('/api/translation/jobs/:id', async (request) => {
      const owner = requireAdmin(request).userId;
      await withTranslationOwnerTransaction(pool, owner, async (client) => {
        await client.query(
          "update translation_jobs set status='cancelled',execution_id=null,updated_at=now() where id=$1 and user_id=$2 and status in ('queued','running')",
          [request.params.id, owner],
        );
      });
      return { ok: true };
    });
    routes.delete('/api/translation/cache', async (request) => {
      const owner = requireAdmin(request).userId;
      await withTranslationOwnerTransaction(pool, owner, async (client) => {
        await client.query('delete from translation_jobs where user_id=$1', [owner]);
      });
      return { ok: true };
    });
  });
}
