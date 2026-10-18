import { assertBrowserOrigin, requirePrincipal } from '../auth.js';
import { SelfHostSetupCode } from '../services/self-host-setup-code.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serverExposure, type ServerConfig } from '../config.js';
import {
  SELF_HOST_SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  requestCookie,
  selfHostSessionCookie,
} from '../auth-cookie.js';
import { SelfHostAuthError, type SelfHostAuthService } from '../services/self-host-auth-service.js';

const AUTH_BODY_LIMIT = 4 * 1024;

interface AccountBody {
  readonly username?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
  readonly setupCode?: unknown;
  readonly replaceCurrentSession?: unknown;
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function throttleKey(request: FastifyRequest): string {
  // Do not include the submitted username: otherwise an attacker can rotate arbitrary
  // usernames to bypass the admission window and grow the in-memory key set.
  return request.ip.slice(0, 200);
}

function authErrorReply(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof Error && 'statusCode' in error)
    return { status: Number(error.statusCode), body: { error: (error as Error).message } };
  if (error instanceof SelfHostAuthError) return { status: error.status, body: { error: error.code } };
  return { status: 500, body: { error: 'authentication_unavailable' } };
}

export async function registerSelfHostAuthRoutes(
  app: FastifyInstance,
  service: SelfHostAuthService,
  config: ServerConfig,
  options: {
    membersReady?: boolean;
    resolveIdentity?: (userId: string) => Promise<{ serverId: string; libraryId: string; accountId: string }>;
  } = {},
): Promise<void> {
  const context = async (account: Awaited<ReturnType<SelfHostAuthService['authenticateSession']>>) => {
    if (!account) return {};
    const identity = options.resolveIdentity ? await options.resolveIdentity(account.userId) : {};
    return {
      account: {
        userId: account.userId,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
      },
      ...identity,
      sessionContext: account.sessionContext,
      capabilities: {
        manageAccounts: account.role === 'admin' && options.membersReady === true,
        manageServer: account.role === 'admin',
        manageExtensions: account.role === 'admin',
        useSources: true,
        useProviders: account.role === 'admin',
        exportLibrary: true,
        restoreLibrary: account.role === 'admin',
      },
      legacyDataOwner: account.userId === config.defaultUserId,
    };
  };
  const current = async (request: FastifyRequest, replacement = false) => {
    assertBrowserOrigin(request, config);
    const account = await service.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    if (account && request.headers['x-boaa-session-context'] !== account.sessionContext)
      throw Object.assign(new Error('session_context_mismatch'), { statusCode: 409 });
    if (account && replacement && (request.body as AccountBody)?.replaceCurrentSession !== true)
      throw Object.assign(new Error('account_session_active'), { statusCode: 409 });
    return account;
  };
  const secureCookie = serverExposure(config) === 'external';
  const setupCode = new SelfHostSetupCode((code) => {
    app.log.warn({ event: 'owner_setup_code', setupCode: code }, 'owner_setup_code');
  });

  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const sessionToken = requestCookie(request, SELF_HOST_SESSION_COOKIE);
    const status = await service.status(sessionToken);
    if (status.setupRequired) setupCode.ensureIssued();
    else setupCode.invalidate();
    const recoveryEnabled = Boolean(config.authToken?.trim());
    return {
      ...status,
      ...(status.account ? await context(status.account) : {}),
      setupCodeRequired: status.setupRequired,
      setupCodeSource: status.setupRequired ? 'server-log' : null,
      legacySetupCodeAccepted: status.setupRequired && recoveryEnabled,
      legacyRecoveryEnabled: recoveryEnabled,
    };
  });

  app.get('/api/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const account = await service.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    if (!account) return reply.code(401).send({ error: 'unauthorized' });
    return { authenticated: true, ...(await context(account)) };
  });

  app.post<{ Body: AccountBody }>('/api/auth/register', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await current(request, true);
      if (!(await service.setupRequired())) {
        setupCode.invalidate();
        throw new SelfHostAuthError('account_already_registered', 409);
      }
      setupCode.verify(bodyString(request.body?.setupCode), throttleKey(request), config.authToken?.trim());
      const session = await service.register({
        username: bodyString(request.body?.username),
        displayName: bodyString(request.body?.displayName) || undefined,
        password: bodyString(request.body?.password),
      });
      setupCode.invalidate();
      reply.header('Set-Cookie', selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie));
      return reply
        .code(201)
        .send({ authenticated: true, ...(await context(session.account)), expiresAt: session.expiresAt });
    } catch (error) {
      const failure = authErrorReply(error);
      if (failure.status === 429) reply.header('Retry-After', '300');
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post<{ Body: AccountBody }>('/api/auth/login', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const username = bodyString(request.body?.username);
    try {
      await current(request, true);
      const session = await service.login({
        username,
        password: bodyString(request.body?.password),
        throttleKey: throttleKey(request),
      });
      reply.header('Set-Cookie', selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie));
      return { authenticated: true, ...(await context(session.account)), expiresAt: session.expiresAt };
    } catch (error) {
      const failure = authErrorReply(error);
      if (failure.status === 429) reply.header('Retry-After', '300');
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await current(request);
      const token = requestCookie(request, SELF_HOST_SESSION_COOKIE);
      await service.logout(token);
      const previous = requestCookie(request, 'moya_session');
      if (previous && previous !== token) await service.logout(previous);
      // Revocation is sufficient. A delayed logout response must not expire a
      // newer session cookie set by another tab while this request was pending.
      return { ok: true };
    } catch (error) {
      const failure = authErrorReply(error);
      return reply.code(failure.status).send(failure.body);
    }
  });
  for (const [path, purpose] of [
    ['/api/auth/invitations/accept', 'invite'],
    ['/api/auth/password-reset/complete', 'password-reset'],
  ] as const) {
    app.post<{ Body: { token?: unknown; password?: unknown } }>(
      path,
      { bodyLimit: AUTH_BODY_LIMIT },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try {
          assertBrowserOrigin(request, config);
          if (await service.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE)))
            return reply.code(409).send({ error: 'account_session_active' });
          const account = await service.redeem(
            bodyString(request.body?.token),
            bodyString(request.body?.password),
            purpose,
            throttleKey(request),
          );
          return { ok: true, ...account };
        } catch (error) {
          const failure = authErrorReply(error);
          return reply.code(failure.status).send(failure.body);
        }
      },
    );
  }
  app.post('/api/auth/logout-all', async (request, reply) => {
    await current(request);
    const principal = requirePrincipal(request);
    if (principal.authMethod !== 'session') return reply.code(403).send({ error: 'account_session_required' });
    await service.revokeAll(principal.userId);
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });
  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
    '/api/auth/password',
    { bodyLimit: AUTH_BODY_LIMIT },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        await current(request);
        const session = await service.changePassword(
          requestCookie(request, SELF_HOST_SESSION_COOKIE) ?? '',
          bodyString(request.body?.currentPassword),
          bodyString(request.body?.newPassword),
          throttleKey(request),
        );
        reply.header(
          'Set-Cookie',
          selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie),
        );
        return { authenticated: true, ...(await context(session.account)), expiresAt: session.expiresAt };
      } catch (error) {
        const failure = authErrorReply(error);
        return reply.code(failure.status).send(failure.body);
      }
    },
  );
  app.post('/api/auth/owner-recovery', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = requirePrincipal(request);
    if (principal.authMethod !== 'legacy-token' || principal.userId !== config.defaultUserId)
      return reply.code(403).send({ error: 'forbidden' });
    return service.ownerRecovery(throttleKey(request));
  });
}
