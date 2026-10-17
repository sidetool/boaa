import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requestCookie, SELF_HOST_SESSION_COOKIE, migratedSessionCookies, clearedSessionCookies } from './auth-cookie';
import { registerAuthHook } from './auth';
import { registerSelfHostAuthRoutes } from './routes/auth';
import { loadConfig } from './config';
import type { SelfHostAuthService } from './services/self-host-auth-service';

const request = (cookie: string) => ({ headers: { cookie }, protocol: 'https' }) as FastifyRequest;
describe('BOAA session cookie upgrade', () => {
  it('reads the old name and emits a secure canonical cookie plus legacy expiry', () => {
    expect(requestCookie(request('moya_session=saved'), SELF_HOST_SESSION_COOKIE)).toBe('saved');
    const cookies = migratedSessionCookies(request('moya_session=saved'))!;
    expect(cookies[0]).toContain('boaa_session=saved; Path=/api; HttpOnly; SameSite=Strict;');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[1]).toContain('moya_session=;');
    expect(cookies[1]).toContain('Max-Age=0');
  });
  it('never lets an old session override an empty, invalid or explicitly new cookie', () => {
    expect(requestCookie(request('boaa_session=new; moya_session=old'), SELF_HOST_SESSION_COOKIE)).toBe('new');
    expect(requestCookie(request('boaa_session=; moya_session=old'), SELF_HOST_SESSION_COOKIE)).toBeUndefined();
    expect(requestCookie(request('boaa_session=%ZZ; moya_session=old'), SELF_HOST_SESSION_COOKIE)).toBeUndefined();
    expect(migratedSessionCookies(request('boaa_session=new; moya_session=old'))).toBeUndefined();
    expect(clearedSessionCookies(request(''))).toHaveLength(2);
  });
  it('migrates only authenticated requests and performs the upgrade once', async () => {
    const app = Fastify();
    const service = {
      authenticateSession: async (token?: string) => (token === 'saved' ? { id: 'owner' } : undefined),
      setupRequired: async () => false,
    } as unknown as SelfHostAuthService;
    await registerAuthHook(app, loadConfig({ SERVER_EXPOSURE: 'loopback' }), service);
    app.get('/api/example', async () => ({ ok: true }));
    try {
      const old = await app.inject({ url: '/api/example', headers: { cookie: 'moya_session=saved' } });
      expect(old.statusCode).toBe(200);
      expect(old.headers['set-cookie']).toHaveLength(2);
      const upgraded = await app.inject({ url: '/api/example', headers: { cookie: 'boaa_session=saved' } });
      expect(upgraded.headers['set-cookie']).toBeUndefined();
      const invalid = await app.inject({
        url: '/api/example',
        headers: { cookie: 'boaa_session=invalid; moya_session=saved' },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it('revokes both sessions and clears both names on logout', async () => {
    const app = Fastify();
    const logout = vi.fn(async () => undefined);
    await registerSelfHostAuthRoutes(
      app,
      { logout } as unknown as SelfHostAuthService,
      loadConfig({ SERVER_EXPOSURE: 'loopback' }),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'boaa_session=new; moya_session=old' },
      });
      expect(response.statusCode).toBe(200);
      expect(logout.mock.calls).toEqual([['new'], ['old']]);
      expect(response.headers['set-cookie']).toHaveLength(2);
      expect(
        (response.headers['set-cookie'] as unknown as string[]).every((cookie) => cookie.includes('Max-Age=0')),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
