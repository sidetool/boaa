import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { requireAdmin } from '../../auth.js';
import { SpeakerGenerationService } from '../../services/speaker-generation-service.js';
import type { AudiobookService } from '../../services/audiobook-service.js';
import type {
  SpeakerGenerationInput,
  SpeakerGenerationPreferences,
  SpeakerRevoiceInput,
} from '../../../../../src/providers/speaker-generation';
import type { SpokenTextRule } from '@boaa/contracts';
import { audiobookError } from '../../services/audiobook-plan.js';
import { normalizeCasting } from '../../services/speaker-voice-selection.js';

export async function registerSpeakerGenerationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  service: SpeakerGenerationService,
  audio: AudiobookService,
  parsePlainTTSRules: (value: unknown) => SpokenTextRule[],
) {
  const active = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const c of active) c.abort();
  });
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (req, reply) => {
      const actor = requireAdmin(req);
      if (actor.userId !== config.defaultUserId) throw audiobookError(403, '분석 기능을 사용할 수 없는 계정이에요.');
      reply.header('Cache-Control', 'private, no-store');
    });
    for (const op of ['list', 'save', 'update', 'delete', 'probe', 'probeSaved'] as const) {
      routes.route<{ Params: { id?: string }; Body: unknown }>({
        method: op === 'list' ? 'GET' : op === 'delete' ? 'DELETE' : op === 'update' ? 'PUT' : 'POST',
        url:
          '/api/tts/speaker-engines' +
          (['update', 'delete', 'probeSaved'].includes(op) ? '/:id' : '') +
          (op.startsWith('probe') ? '/probe' : ''),
        bodyLimit: 160 * 1024,
        handler: async (req, reply) => {
          if (op === 'list') return { engines: await service.engines.list() };
          if (op === 'delete') {
            await service.engines.remove(req.params.id!);
            return { ok: true };
          }
          if (!op.startsWith('probe')) return service.engines.save(req.body, req.params.id);
          if (active.size >= 2) throw audiobookError(429, '다른 연결을 확인 중이에요. 잠시 후 다시 확인해 주세요.');
          const c = new AbortController();
          active.add(c);
          const timer = setTimeout(() => c.abort(), 25000);
          const close = () => {
            if (!reply.raw.writableFinished) c.abort();
          };
          req.raw.once('aborted', close);
          reply.raw.once('close', close);
          try {
            return await service.engines.probe(req.body, c.signal, req.params.id);
          } finally {
            clearTimeout(timer);
            active.delete(c);
            req.raw.removeListener('aborted', close);
            reply.raw.removeListener('close', close);
          }
        },
      });
    }
    const input = (body: unknown): SpeakerGenerationInput => {
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw audiobookError(400, '생성 설정을 확인해 주세요.');
      const b = body as SpeakerGenerationInput;
      return {
        chapterIds: b.chapterIds,
        engineId: b.engineId,
        narratorVoiceId: b.narratorVoiceId,
        characterVoiceIds: b.characterVoiceIds,
        casting: normalizeCasting(b.casting),
        autoActing: b.autoActing,
        rules: parsePlainTTSRules(b.rules),
        footnotePlayback: b.footnotePlayback,
      };
    };
    routes.get<{ Params: { bookId: string } }>('/api/books/:bookId/speaker-generation', async (req) => ({
      jobs: await service.list(req.params.bookId),
    }));
    routes.get<{ Params: { bookId: string } }>('/api/books/:bookId/speaker-generation/preferences', async (req) => ({
      preferences: (
        await pool.query(
          'select p.value from speaker_generation_preferences p join library_books b on b.id=p.book_id where p.book_id=$1 and p.user_id=$2 and b.user_id=$2 and b.deleted_at is null',
          [req.params.bookId, config.defaultUserId],
        )
      ).rows[0]?.value,
    }));
    routes.put<{ Params: { bookId: string }; Body: SpeakerGenerationPreferences }>(
      '/api/books/:bookId/speaker-generation/preferences',
      { bodyLimit: 32768 },
      async (req) => {
        const v = req.body;
        const valid = (s: unknown) => typeof s === 'string' && s.length <= 512;
        if (
          !v ||
          (v.autoActing !== undefined && typeof v.autoActing !== 'boolean') ||
          !valid(v.engineId) ||
          !valid(v.narratorVoiceId) ||
          !Array.isArray(v.characterVoiceIds) ||
          v.characterVoiceIds.length > 32 ||
          !v.characterVoiceIds.every(valid)
        )
          throw audiobookError(400, '선택한 모델과 목소리를 확인해 주세요.');
        const value = {
          engineId: v.engineId,
          narratorVoiceId: v.narratorVoiceId,
          characterVoiceIds: [...new Set(v.characterVoiceIds)],
          casting: normalizeCasting(v.casting, true),
          ...(typeof v.autoActing === 'boolean' ? { autoActing: v.autoActing } : {}),
        };
        const written = await pool.query(
          `insert into speaker_generation_preferences(book_id,user_id,value)
        select id,user_id,$3::jsonb from library_books where id=$1 and user_id=$2 and deleted_at is null
        on conflict(book_id) do update set value=excluded.value,updated_at=now() where speaker_generation_preferences.user_id=excluded.user_id`,
          [req.params.bookId, config.defaultUserId, JSON.stringify(value)],
        );
        if (!written.rowCount) throw audiobookError(404, '작품을 찾을 수 없어요.');
        return { ok: true };
      },
    );
    routes.post<{ Params: { bookId: string }; Body: unknown }>(
      '/api/books/:bookId/speaker-generation/estimate',
      { bodyLimit: 256 * 1024 },
      async (req) => service.estimate(req.params.bookId, input(req.body)),
    );
    routes.get<{ Params: { bookId: string; id: string } }>(
      '/api/books/:bookId/speaker-generation/:id/revoice',
      async (req) => service.revoiceSource(req.params.bookId, req.params.id),
    );
    routes.post<{ Params: { bookId: string; id: string }; Body: SpeakerRevoiceInput }>(
      '/api/books/:bookId/speaker-generation/:id/revoice/estimate',
      { bodyLimit: 256 * 1024 },
      async (req) => service.estimateRevoice(req.params.bookId, req.params.id, req.body),
    );
    routes.post<{
      Params: { bookId: string; id: string };
      Body: SpeakerRevoiceInput & { fingerprint: string; confirmPaid?: boolean };
    }>('/api/books/:bookId/speaker-generation/:id/revoice', { bodyLimit: 256 * 1024 }, async (req) =>
      service.revoice(
        req.params.bookId,
        req.params.id,
        req.body,
        req.body?.fingerprint,
        req.body?.confirmPaid === true,
      ),
    );
    routes.get<{ Params: { bookId: string; id: string } }>(
      '/api/books/:bookId/speaker-generation/:id/castings',
      async (req) => {
        if (!(await service.list(req.params.bookId)).some((j) => j.id === req.params.id))
          throw audiobookError(404, '생성 작업을 찾을 수 없어요.');
        return { assignments: await service.castings(req.params.id) };
      },
    );
    routes.put<{ Params: { bookId: string; id: string }; Body: { speakerId: string; voiceId: string } }>(
      '/api/books/:bookId/speaker-generation/:id/castings',
      { bodyLimit: 4096 },
      async (req) => {
        if (!(await service.list(req.params.bookId)).some((j) => j.id === req.params.id))
          throw audiobookError(404, '생성 작업을 찾을 수 없어요.');
        if (
          typeof req.body?.speakerId !== 'string' ||
          req.body.speakerId.length > 256 ||
          typeof req.body.voiceId !== 'string' ||
          req.body.voiceId.length > 512
        )
          throw audiobookError(400, '인물과 목소리를 확인해 주세요.');
        await service.assign(req.params.id, req.body.speakerId, req.body.voiceId);
        return { ok: true };
      },
    );
    routes.post<{
      Params: { bookId: string };
      Body: SpeakerGenerationInput & { fingerprint: string; confirmPaid: boolean };
    }>('/api/books/:bookId/speaker-generation', { bodyLimit: 256 * 1024 }, async (req) =>
      service.create(req.params.bookId, input(req.body), req.body.fingerprint, req.body.confirmPaid === true),
    );
    routes.post<{
      Params: { bookId: string; id: string };
      Body: { action: 'pause' | 'resume'; confirmPaid?: boolean };
    }>('/api/books/:bookId/speaker-generation/:id/control', async (req) => {
      if (!(await service.list(req.params.bookId)).some((j) => j.id === req.params.id))
        throw audiobookError(404, '생성 작업을 찾을 수 없어요.');
      await audio.control(req.params.id, req.body?.action, req.body?.confirmPaid === true);
      return (await service.list(req.params.bookId)).find((j) => j.id === req.params.id);
    });
    routes.delete<{ Params: { bookId: string; id: string } }>(
      '/api/books/:bookId/speaker-generation/:id',
      async (req) => {
        if (!(await service.list(req.params.bookId)).some((j) => j.id === req.params.id))
          throw audiobookError(404, '생성 작업을 찾을 수 없어요.');
        await service.remove(req.params.id);
        return { ok: true };
      },
    );
  });
}
