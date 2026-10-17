import Fastify from 'fastify';
import { createStructuredLogger } from '../observability/logger.js';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { registerAuthHook } from '../auth.js';
import { SelfHostAuthService, type SelfHostAuthStore } from '../services/self-host-auth-service.js';
import { registerSelfHostAuthRoutes } from './auth.js';

type StoredAccount = NonNullable<Awaited<ReturnType<SelfHostAuthStore['loadAccount']>>>;

class RouteAuthStore implements SelfHostAuthStore {
  account?: StoredAccount;
  sessions = new Map<string, { userId: string; expiresAt: string }>();
  async loadAccount() {
    return this.account;
  }
  async createAccount(account: StoredAccount) {
    if (this.account) return false;
    this.account = account;
    return true;
  }
  async updateUserDisplayName() {}
  async createSession(userId: string, tokenHash: string, expiresAt: string) {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }
  async resolveSession(tokenHash: string, now: string) {
    const session = this.sessions.get(tokenHash);
    return session && session.expiresAt > now && session.userId === this.account?.userId ? this.account : undefined;
  }
  async revokeSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async deleteExpiredSessions() {}
}

function config(exposure: 'loopback' | 'external', authToken?: string): ServerConfig {
  return {
    host: exposure === 'external' ? '0.0.0.0' : '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1/test',
    redisUrl: 'redis://127.0.0.1',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024,
    staleUploadMaxAgeMs: 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    exposure,
    authToken,
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

function cookieValue(setCookie: string | string[] | undefined): string {
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0] ?? '';
}

describe('self-host account routes', () => {
  it('requires the deployment setup code once and issues a secure persistent owner session', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('external', 'first-device-code'));

    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json()).toMatchObject({ setupRequired: true, setupCodeRequired: true, authenticated: false });
    expect(status.headers['cache-control']).toBe('no-store');

    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'wrong' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'invalid_setup_code' });

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'first-device-code' },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers['set-cookie']).toContain('HttpOnly');
    expect(registered.headers['set-cookie']).toContain('SameSite=Strict');
    expect(registered.headers['set-cookie']).toContain('Secure');
    expect(registered.headers['set-cookie']).toContain('Max-Age=2592000');

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookieValue(registered.headers['set-cookie']) },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, account: { username: 'owner' } });
    await app.close();
  });

  it('logs in a second device and clears only that cookie on logout', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('loopback', 'synthetic-legacy-token'));
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });

    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });
    const cookie = cookieValue(loggedIn.headers['set-cookie']);
    expect(loggedIn.statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.headers['set-cookie']).toHaveLength(2);
    expect((logout.headers['set-cookie'] as string[]).every((value) => value.includes('Max-Age=0'))).toBe(true);
    const expired = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });

  it('bounds auth request bodies and throttles an IP even when submitted usernames rotate', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('loopback', 'synthetic-legacy-token'));
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'x'.repeat(5_000) },
    });
    expect(oversized.statusCode).toBe(413);

    for (let index = 0; index < 8; index += 1) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: `rotated-${index}`, password: 'a sufficiently long password' },
      });
      expect(denied.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });
    expect(throttled.statusCode).toBe(429);
    await app.close();
  });

  it('uses the durable owner cookie on protected routes while preserving bearer recovery access', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    const serverConfig = config('external', 'recovery-code');
    await registerAuthHook(app, serverConfig, service);
    await registerSelfHostAuthRoutes(app, service, serverConfig);
    app.get('/api/books', async () => ({ books: [] }));

    const beforeSetup = await app.inject({ method: 'GET', url: '/api/books' });
    expect(beforeSetup.statusCode).toBe(503);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'recovery-code' },
    });
    const cookie = cookieValue(registered.headers['set-cookie']);
    const cookieAccess = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie } });
    const recoveryAccess = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { authorization: 'Bearer recovery-code' },
    });

    expect(cookieAccess.statusCode).toBe(200);
    expect(recoveryAccess.statusCode).toBe(200);
    await app.close();
  });
});

it('requires logged one-time codes even on loopback, throttles setup, and stops logging after registration', async () => {
  const events: { event?: string; setupCode?: string }[] = [];
  const app = Fastify({
    loggerInstance: createStructuredLogger({
      service: 'api',
      sink: {
        write: (line) => {
          events.push(JSON.parse(line));
        },
      },
    }).fastify,
  });
  const store = new RouteAuthStore();
  const service = new SelfHostAuthService(store, 'user_test');
  await registerSelfHostAuthRoutes(app, service, config('loopback'));
  const status = await app.inject('/api/auth/status');
  expect(status.json()).toMatchObject({
    setupRequired: true,
    setupCodeRequired: true,
    setupCodeSource: 'server-log',
    legacySetupCodeAccepted: false,
  });
  const code = events.find((event) => event.event === 'owner_setup_code')?.setupCode;
  expect(Boolean(code)).toBe(true);
  expect(status.body.includes(code!)).toBe(false);
  await app.inject('/api/auth/status');
  expect(events.filter((event) => event.event === 'owner_setup_code').length).toBe(1);
  const register = (setupCode?: string, remoteAddress = '127.0.0.1') =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress,
      payload: { username: 'owner', password: 'long synthetic password', setupCode },
    });
  for (let i = 0; i < 8; i++) expect((await register()).statusCode).toBe(403);
  expect((await register(code)).statusCode).toBe(429);
  expect((await register(code, '127.0.0.2')).statusCode).toBe(201);
  expect((await register(code)).statusCode).toBe(409);
  expect((await app.inject('/api/auth/status')).json()).toMatchObject({
    setupRequired: false,
    setupCodeRequired: false,
    setupCodeSource: null,
    legacySetupCodeAccepted: false,
  });
  expect(events.filter((event) => event.event === 'owner_setup_code').length).toBe(1);
  await app.close();
  const restartedEvents: string[] = [];
  const restarted = Fastify({
    logger: {
      level: 'warn',
      stream: {
        write: (line: string) => {
          restartedEvents.push(line);
        },
      },
    },
  });
  await registerSelfHostAuthRoutes(restarted, service, config('loopback'));
  await restarted.inject('/api/auth/status');
  expect(restartedEvents.length).toBe(0);
  await restarted.close();
});

it('shared database rejects other API-instance codes once one owner is committed', async () => {
  const store = new RouteAuthStore();
  const apps = [Fastify({ logger: false }), Fastify({ logger: false })];
  for (const app of apps)
    await registerSelfHostAuthRoutes(
      app,
      new SelfHostAuthService(store, 'user_test'),
      config('loopback', 'synthetic-legacy'),
    );
  await Promise.all(apps.map((app) => app.inject('/api/auth/status')));
  const results = await Promise.all(
    apps.map((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'owner', password: 'long synthetic password', setupCode: 'synthetic-legacy' },
      }),
    ),
  );
  expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
  for (const app of apps) {
    expect((await app.inject('/api/auth/status')).json().setupCodeRequired).toBe(false);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { setupCode: 'synthetic-legacy' } }))
        .statusCode,
    ).toBe(409);
    await app.close();
  }
});
