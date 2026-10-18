import type { RequestPrincipal } from '@boaa/contracts';
import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance, type FastifyRequest } from 'fastify';
import { corsAllowedOrigins, assertSecureServerConfig, type ServerConfig } from './config.js';
import { hasSessionCookie, SELF_HOST_SESSION_COOKIE, requestCookie } from './auth-cookie.js';
import type { SelfHostAuthService } from './services/self-host-auth-service.js';
import { isWebAssetRequest } from './routes/web-assets.js';

function tokenFromAuthorizationHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer[\t ]+([^\t ]+)[\t ]*$/i);
  return match?.[1];
}

function safeTokenEquals(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isPublicRequest(method: string, url: string): boolean {
  if (method.toUpperCase() === 'OPTIONS') return true;
  const path = url.split('?', 1)[0];
  return (
    path === '/health' ||
    path === '/api/health' ||
    path === '/ready' ||
    path === '/api/ready' ||
    path === '/api/auth/status' ||
    path === '/api/auth/session' ||
    path === '/api/auth/register' ||
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/invitations/accept' ||
    path === '/api/auth/password-reset/complete'
  );
}

export function authEnabled(config: ServerConfig): boolean {
  return Boolean(config.authToken?.trim());
}

export async function registerAuthHook(
  app: FastifyInstance,
  config: ServerConfig,
  selfHostAuth?: SelfHostAuthService,
): Promise<void> {
  assertSecureServerConfig(config);
  app.decorateRequest('principal', null);
  const expectedToken = config.authToken?.trim();
  if (!expectedToken && !selfHostAuth) return;

  app.addHook('onRequest', async (request, reply) => {
    if (
      config.pluginOrigin &&
      ['GET', 'HEAD'].includes(request.method) &&
      /^\/plugin-runtime\/(shell|controller-worker\.js|quickjs\.wasm)$/.test(request.url)
    )
      return;
    if (config.webRoot && isWebAssetRequest(request)) return;
    if (isPublicRequest(request.method, request.url)) return;
    // Navigation cannot set bearer headers. Only legacy-issued, owner-bound one-use
    // tickets may authorize this branch; the ticket handler validates that capability.
    const legacyNavigation =
      request.method === 'GET' &&
      /^\/api\/(?:original-downloads|backups\/download)\/[A-Za-z0-9_-]{43}$/.test(request.url.split('?')[0]);
    if (legacyNavigation && !hasSessionCookie(request) && !request.headers.authorization) return;
    const token = tokenFromAuthorizationHeader(request.headers.authorization);
    if (!hasSessionCookie(request) && expectedToken && safeTokenEquals(token, expectedToken)) {
      request.principal = Object.freeze({ userId: config.defaultUserId, role: 'admin', authMethod: 'legacy-token' });
      return;
    }
    const account = await selfHostAuth?.authenticateSession(requestCookie(request, SELF_HOST_SESSION_COOKIE));
    if (account) {
      request.principal = Object.freeze({
        userId: account.userId,
        role: account.role,
        authMethod: 'session',
        sessionContext: account.sessionContext,
        authVersion: account.authVersion,
      });
      const ticketPath = /^\/api\/(?:original-downloads|backups\/download)\/[A-Za-z0-9_-]{43}$/.test(
        request.url.split('?')[0],
      );
      const context = request.headers['x-boaa-session-context'];
      if (!ticketPath && (!account.sessionContext || context !== account.sessionContext))
        return reply.code(409).send({ error: 'session_context_mismatch' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertBrowserOrigin(request, config);
      return;
    }
    if (selfHostAuth && (await selfHostAuth.setupRequired())) {
      return reply.code(503).send({ error: 'account_setup_required' });
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: RequestPrincipal | null;
  }
}
export function requirePrincipal(request: FastifyRequest): RequestPrincipal {
  if (!request.principal) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return request.principal;
}
export function requireUserId(request: FastifyRequest): string {
  return requirePrincipal(request).userId;
}
export function requireAdmin(request: FastifyRequest): RequestPrincipal {
  const principal = requirePrincipal(request);
  if (principal.role !== 'admin') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  return principal;
}
export function assertBrowserOrigin(request: FastifyRequest, config: ServerConfig): void {
  const origin = request.headers.origin;
  let candidate = origin;
  if (!candidate && request.headers.referer) {
    try {
      candidate = new URL(request.headers.referer).origin;
    } catch {
      // An invalid Referer remains absent and is rejected by the origin check below.
    }
  }
  const sameOrigin = `${request.protocol}://${request.host}`;
  if (
    !candidate ||
    candidate === 'null' ||
    (candidate !== sameOrigin && !corsAllowedOrigins(config).includes(candidate))
  )
    throw Object.assign(new Error('invalid_origin'), { statusCode: 403 });
}
