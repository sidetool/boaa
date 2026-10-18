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
  sessions = new Map<string, { userId: string; expiresAt: string; sessionContext?: string }>();
  async loadAccount() {
    return this.account;
  }
  async createAccount(account: StoredAccount) {
    if (this.account) return false;
    this.account = account;
    return true;
  }
  async updateUserDisplayName() {}
  async createSession(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    _version?: number,
    sessionContext?: string,
  ) {
    this.sessions.set(tokenHash, { userId, expiresAt, sessionContext });
  }
  async resolveSession(tokenHash: string, now: string) {
    const session = this.sessions.get(tokenHash);
    return session && session.expiresAt > now && session.userId === this.account?.userId
      ? { ...this.account, sessionContext: session.sessionContext }
      : undefined;
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
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'wrong' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'invalid_setup_code' });

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-proto': 'https', origin: 'http://localhost:80' },
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
      headers: {
        cookie: cookieValue(registered.headers['set-cookie']),
        'x-boaa-session-context': registered.json().sessionContext,
      },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, account: { username: 'owner' } });
    await app.close();
  });

  it('logs in a second device and revokes only that session without rewriting cookies', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('loopback', 'synthetic-legacy-token'));
    await app.inject({
      method: 'POST',
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });

    const loggedIn = await app.inject({
      method: 'POST',
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });
    const cookie = cookieValue(loggedIn.headers['set-cookie']);
    expect(loggedIn.statusCode).toBe(200);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'http://localhost:80', 'x-boaa-session-context': loggedIn.json().sessionContext },
    });
    expect(logout.headers['set-cookie']).toBeUndefined();
    const expired = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie, origin: 'http://localhost:80', 'x-boaa-session-context': loggedIn.json().sessionContext },
    });
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
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'synthetic-legacy-token' },
    });

    const oversized = await app.inject({
      method: 'POST',
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'x'.repeat(5_000) },
    });
    expect(oversized.statusCode).toBe(413);

    for (let index = 0; index < 8; index += 1) {
      const denied = await app.inject({
        method: 'POST',
        headers: { origin: 'http://localhost:80' },
        url: '/api/auth/login',
        payload: { username: `rotated-${index}`, password: 'a sufficiently long password' },
      });
      expect(denied.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: 'POST',
      headers: { origin: 'http://localhost:80' },
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
      headers: { origin: 'http://localhost:80' },
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'recovery-code' },
    });
    const cookie = cookieValue(registered.headers['set-cookie']);
    const cookieAccess = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { cookie, origin: 'http://localhost:80', 'x-boaa-session-context': registered.json().sessionContext },
    });
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
      headers: { origin: 'http://localhost:80' },
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
        headers: { origin: 'http://localhost:80' },
        url: '/api/auth/register',
        payload: { username: 'owner', password: 'long synthetic password', setupCode: 'synthetic-legacy' },
      }),
    ),
  );
  expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
  for (const app of apps) {
    expect((await app.inject('/api/auth/status')).json().setupCodeRequired).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          headers: { origin: 'http://localhost:80' },
          url: '/api/auth/register',
          payload: { setupCode: 'synthetic-legacy' },
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
  }
});

it('rejects stale logout and implicit login replacement without changing the active cookie', async () => {
  const app = Fastify();
  const service = new SelfHostAuthService(new RouteAuthStore(), 'user_test');
  const session = await service.register({ username: 'owner', password: 'a sufficiently long password' });
  await registerSelfHostAuthRoutes(app, service, config('loopback'));
  const headers = {
    cookie: `boaa_session=${session.token}`,
    origin: 'http://localhost:80',
    'x-boaa-session-context': 'stale',
  };
  const stale = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
  expect(stale.statusCode).toBe(409);
  expect(stale.headers['set-cookie']).toBeUndefined();
  expect(await service.authenticateSession(session.token)).toBeDefined();
  const replacement = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { ...headers, 'x-boaa-session-context': session.account.sessionContext! },
    payload: { username: 'owner', password: 'a sufficiently long password' },
  });
  expect(replacement.statusCode).toBe(409);
  expect(replacement.json()).toEqual({ error: 'account_session_active' });
  for (const origin of [undefined, 'null', 'https://attacker.example']) {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: origin ? { origin } : {},
      payload: { username: 'owner', password: 'a sufficiently long password' },
    });
    expect(denied.statusCode).toBe(403);
  }
  await app.close();
});

it.each(['/api/auth/logout', '/api/auth/logout-all'])(
  'a delayed %s response does not clear a later login cookie',
  async (path) => {
    const app = Fastify();
    const a = { userId: 'a', username: 'a', displayName: 'A', role: 'admin' as const, sessionContext: 'context-a' };
    const b = { userId: 'b', username: 'b', displayName: 'B', role: 'member' as const, sessionContext: 'context-b' };
    const sessions = new Map<string, typeof a | typeof b>([['token-a', a]]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let revoked!: () => void;
    const revokedPromise = new Promise<void>((resolve) => {
      revoked = resolve;
    });
    const revoke = async () => {
      sessions.delete('token-a');
      revoked();
      await held;
    };
    const service = {
      authenticateSession: async (token: string) => sessions.get(token),
      setupRequired: async () => false,
      logout: revoke,
      revokeAll: revoke,
      login: async () => {
        sessions.set('token-b', b);
        return { token: 'token-b', account: b, expiresAt: '2099-01-01T00:00:00Z' };
      },
    } as unknown as SelfHostAuthService;
    app.addHook('onRequest', async (request) => {
      request.principal = { userId: 'a', role: 'admin', authMethod: 'session', sessionContext: 'context-a' };
    });
    await registerSelfHostAuthRoutes(app, service, config('loopback'));
    const pending = app
      .inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: 'boaa_session=token-a',
          origin: 'http://localhost:80',
          'x-boaa-session-context': 'context-a',
        },
      })
      .then((response) => response);
    try {
      await revokedPromise;
      const loggedIn = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { cookie: 'boaa_session=token-a', origin: 'http://localhost:80' },
        payload: { username: 'b', password: 'fixture-password' },
      });
      expect(loggedIn.statusCode).toBe(200);
      expect(cookieValue(loggedIn.headers['set-cookie'])).toBe('boaa_session=token-b');
      release();
      const logout = await pending;
      expect(logout.statusCode).toBe(200);
      expect(logout.headers['set-cookie']).toBeUndefined();
      const active = await app.inject({ url: '/api/auth/session', headers: { cookie: 'boaa_session=token-b' } });
      expect(active.json().account.userId).toBe('b');
    } finally {
      release();
      await app.close();
    }
  },
);

it('a delayed legacy-cookie session read cannot overwrite a newer canonical cookie', async () => {
  const app = Fastify();
  const service = new SelfHostAuthService(new RouteAuthStore(), 'user_test');
  const a = await service.register({ username: 'owner', password: 'a sufficiently long password' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    ready = resolve;
  });
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.url === '/api/auth/session' && request.headers.cookie?.startsWith('moya_session=')) {
      ready();
      await held;
    }
    return payload;
  });
  await registerSelfHostAuthRoutes(app, service, config('loopback'));
  const pending = app
    .inject({ url: '/api/auth/session', headers: { cookie: `moya_session=${a.token}` } })
    .then((response) => response);
  try {
    await pendingResponse;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        cookie: `moya_session=${a.token}`,
        origin: 'http://localhost:80',
        'x-boaa-session-context': a.account.sessionContext!,
      },
      payload: { username: 'owner', password: 'a sufficiently long password', replaceCurrentSession: true },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('boaa_session=');
    release();
    const read = await pending;
    expect(read.statusCode).toBe(200);
    expect(read.headers['set-cookie']).toBeUndefined();
  } finally {
    release();
    await app.close();
  }
});
