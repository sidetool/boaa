import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth.js';
import { SelfHostAuthError, type SelfHostAuthService } from '../services/self-host-auth-service.js';
export async function registerAdminAccountRoutes(
  app: FastifyInstance,
  service: SelfHostAuthService,
  options: { membersReady?: boolean; onMemberDisabled?: (userId: string) => Promise<void> } = {},
) {
  app.register(async (admin) => {
    admin.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      requireAdmin(request);
    });
    admin.setErrorHandler((error, request, reply) => {
      if (error instanceof SelfHostAuthError) return reply.code(error.status).send({ error: error.code });
      return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({
        error: (error as { statusCode?: number }).statusCode
          ? (error as Error).message
          : 'account_administration_unavailable',
      });
    });
    admin.get('/api/admin/accounts', async () => ({ accounts: await service.listAccounts() }));
    admin.post<{ Body: { username?: string; displayName?: string } }>(
      '/api/admin/accounts',
      { bodyLimit: 4096 },
      async (request, reply) => {
        if (!options.membersReady) return reply.code(503).send({ error: 'members_not_ready' });
        const grant = await service.invite(
          requireAdmin(request).userId,
          typeof request.body?.username === 'string' ? request.body.username : '',
          request.body?.displayName,
        );
        return reply.code(201).send(grant);
      },
    );
    admin.patch<{ Params: { userId: string }; Body: { displayName?: string; enabled?: boolean } }>(
      '/api/admin/accounts/:userId',
      { bodyLimit: 4096 },
      async (request, reply) => {
        const body = request.body;
        if (
          !body ||
          Object.keys(body).some((key) => !['displayName', 'enabled'].includes(key)) ||
          (body.displayName !== undefined && typeof body.displayName !== 'string') ||
          (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        )
          return reply.code(400).send({ error: 'invalid_account_update' });
        const result = await service.updateAccount(request.params.userId, body);
        if (body.enabled === false) await options.onMemberDisabled?.(request.params.userId);
        return result;
      },
    );
    for (const [path, purpose] of [
      ['invitation', 'invite'],
      ['password-reset', 'password-reset'],
    ] as const)
      admin.post<{ Params: { userId: string } }>(`/api/admin/accounts/:userId/${path}`, async (request) =>
        service.issueAccountToken(requireAdmin(request).userId, request.params.userId, purpose),
      );
    admin.delete<{ Params: { userId: string } }>('/api/admin/accounts/:userId/sessions', async (request) => {
      await service.revokeAll(request.params.userId);
      return { ok: true };
    });
  });
}
