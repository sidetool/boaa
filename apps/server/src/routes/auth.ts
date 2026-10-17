import { SelfHostSetupCode } from '../services/self-host-setup-code.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serverExposure, type ServerConfig } from '../config.js';
import {
  SELF_HOST_SESSION_COOKIE,
  clearedSessionCookies,
  migratedSessionCookies,
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
  if (error instanceof SelfHostAuthError) return { status: error.status, body: { error: error.code } };
  return { status: 500, body: { error: 'authentication_unavailable' } };
}

export async function registerSelfHostAuthRoutes(
  app: FastifyInstance,
  service: SelfHostAuthService,
  config: ServerConfig,
): Promise<void> {
  const secureCookie = serverExposure(config) === 'external';
  const setupCode = new SelfHostSetupCode((code) => {
    app.log.warn({ event: 'owner_setup_code', setupCode: code }, 'owner_setup_code');
  });

  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const sessionToken = requestCookie(request, SELF_HOST_SESSION_COOKIE);
    const status = await service.status(sessionToken);
    const cookies = status.authenticated ? migratedSessionCookies(request, secureCookie) : undefined;
    if (cookies) reply.header('Set-Cookie', cookies);
    if (status.setupRequired) setupCode.ensureIssued();
    else setupCode.invalidate();
    const recoveryEnabled = Boolean(config.authToken?.trim());
    return {
      ...status,
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
    const cookies = migratedSessionCookies(request, secureCookie);
    if (cookies) reply.header('Set-Cookie', cookies);
    return { authenticated: true, account };
  });

  app.post<{ Body: AccountBody }>('/api/auth/register', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
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
      return reply.code(201).send({ authenticated: true, account: session.account, expiresAt: session.expiresAt });
    } catch (error) {
      const failure = authErrorReply(error);
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post<{ Body: AccountBody }>('/api/auth/login', { bodyLimit: AUTH_BODY_LIMIT }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const username = bodyString(request.body?.username);
    try {
      const session = await service.login({
        username,
        password: bodyString(request.body?.password),
        throttleKey: throttleKey(request),
      });
      reply.header('Set-Cookie', selfHostSessionCookie(request, session.token, SESSION_MAX_AGE_SECONDS, secureCookie));
      return { authenticated: true, account: session.account, expiresAt: session.expiresAt };
    } catch (error) {
      const failure = authErrorReply(error);
      return reply.code(failure.status).send(failure.body);
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = requestCookie(request, SELF_HOST_SESSION_COOKIE);
    await service.logout(token);
    const previous = requestCookie(request, 'moya_session');
    if (previous && previous !== token) await service.logout(previous);
    reply.header('Set-Cookie', clearedSessionCookies(request, secureCookie));
    return { ok: true };
  });
}
