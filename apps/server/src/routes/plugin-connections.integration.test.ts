import { afterAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPluginConnectionRoutes } from './plugin-connections';
import { loadConfig } from '../config';
import { migrateDatabase } from '../db/migrate';
import { seedDefaultUser } from '../db/pool';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../services/self-host-auth-service';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness';
import { SELF_HOST_SESSION_COOKIE } from '../auth-cookie';
import { testPluginBackend } from './test-fixtures/plugin-backend';
const harness = await startPostgresIntegrationHarness();
afterAll(() => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
it.skipIf(!harness)(
  'real account grants, encrypted keys, two backends, CRUD, fences, cancellation and unknown write outcomes',
  async () => {
    const a = await testPluginBackend('notes'),
      b = await testPluginBackend('dictionary'),
      dir = await mkdtemp(join(tmpdir(), 'boaa-plugin-http-'));
    const previous = process.env.JS_PLUGIN_PRIVATE_ORIGINS;
    process.env.JS_PLUGIN_PRIVATE_ORIGINS = JSON.stringify([a.origin, b.origin]);
    try {
      await withPostgresSchema(harness!, 'plugin_http', async (pool) => {
        await migrateDatabase(pool);
        await seedDefaultUser(pool, 'owner');
        const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'owner');
        const account = await auth.register({ username: 'http-owner', password: 'Synthetic-plugin-password-2026!' });
        const app = Fastify();
        registerPluginConnectionRoutes(
          app,
          loadConfig({
            SERVER_DATA_DIR: dir,
            JS_PLUGIN_ORIGIN: 'https://boaa.test',
            DEFAULT_USER_ID: 'owner',
            JS_PLUGIN_PRIVATE_ORIGINS: JSON.stringify([a.origin, b.origin]),
          }),
          pool,
        );
        const headers = {
          origin: 'https://boaa.test',
          'x-boaa-plugin-host': '1',
          cookie: `${SELF_HOST_SESSION_COOKIE}=${account.token}`,
        };
        const owner = { profileId: randomUUID(), installationId: randomUUID(), digest: 'a'.repeat(64), generation: 1 };
        const call = (action: string, data: Record<string, unknown> = {}, customHeaders = headers) =>
          app.inject({
            method: 'POST',
            url: `/api/plugins/connections/${action}`,
            headers: customHeaders,
            payload: { owner, ...data },
          });
        const approve = () =>
          call('approve', {
            headers: ['content-type', 'accept'],
            slot: 'backend',
            endpoint: a.origin + '/v1/',
            roles: ['controller'],
            methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
            auth: { kind: 'bearer', value: 'synthetic-plugin-key' },
          });
        try {
          expect((await approve()).statusCode).toBe(200);
          let connection = (await call('list')).json()[0];
          expect(JSON.stringify(connection)).not.toContain('synthetic-plugin-key');
          const rows = await pool.query('select encrypted_secret from plugin_connections');
          expect(rows.rows[0].encrypted_secret).not.toContain('synthetic-plugin-key');
          const request = (patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
            call('request', {
              requestId: randomUUID(),
              role: 'controller',
              revision: connection.revision,
              request: { slot: 'backend', path: 'notes', method: 'POST', response: 'json', body: 'hello', ...patch },
              ...extra,
            });
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            const response = await request({ method, body: method === 'GET' ? undefined : 'hello' });
            expect(response.json()).toMatchObject({ ok: true, status: 200, body: { service: 'notes', method } });
            expect(response.json().headers['set-cookie']).toBeUndefined();
          }
          expect(a.requests).toHaveLength(5);
          expect(a.requests.every((r) => r.authenticated)).toBe(true);
          expect((await request({ path: 'empty' })).json()).toMatchObject({ ok: true, status: 204, body: null });
          expect((await request({ method: 'HEAD', body: undefined })).json()).toMatchObject({
            ok: true,
            status: 200,
            body: null,
          });
          expect((await request({ path: 'denied' })).json()).toMatchObject({ ok: true, status: 429 });
          const redirect = await request({ path: 'redirect', response: 'text' });
          expect(redirect.json()).toMatchObject({ ok: true, status: 302 });
          expect(a.requests.some((r) => r.url.includes('forbidden-redirect'))).toBe(false);
          expect((await request({ path: 'large' })).json()).toMatchObject({ ok: false, outcome: 'unknown' });
          expect((await request({ path: 'disconnect' })).json()).toMatchObject({ ok: false, outcome: 'unknown' });
          const before = a.requests.length;
          for (const patch of [
            { path: '../admin' },
            { path: '//other.test/' },
            { headers: { authorization: 'evil' } },
            { headers: { cookie: 'secret' } },
            { headers: { 'x-forwarded-host': 'evil' } },
          ])
            expect((await request(patch)).json()).toMatchObject({ ok: false, outcome: 'not-sent' });
          for (const extra of [
            { role: 'ui' },
            { owner: { ...owner, generation: 2 } },
            { owner: { ...owner, digest: 'b'.repeat(64) } },
            { owner: { ...owner, profileId: randomUUID() } },
            { revision: randomUUID() },
          ])
            expect((await request({}, extra)).statusCode).toBe(403);
          expect(a.requests).toHaveLength(before);
          expect((await call('list', {}, { ...headers, origin: 'null' })).statusCode).toBe(403);
          expect((await call('list', {}, { ...headers, cookie: '' })).statusCode).toBe(403);
          const duplicate = randomUUID();
          expect((await request({}, { requestId: duplicate })).statusCode).toBe(200);
          expect((await request({}, { requestId: duplicate })).statusCode).toBe(403);
          const cancelled = randomUUID();
          await call('cancel', { requestId: cancelled });
          expect((await request({}, { requestId: cancelled })).statusCode).toBe(403);
          const activeId = randomUUID(),
            waiting = request({ path: 'slow' }, { requestId: activeId });
          await new Promise((r) => setTimeout(r, 150));
          await call('cancel', { requestId: activeId });
          expect((await waiting).json()).toMatchObject({ ok: false, outcome: 'unknown' });
          const revoked = request({ path: 'slow' });
          await new Promise((r) => setTimeout(r, 150));
          await call('revoke');
          expect((await revoked).json()).toMatchObject({ ok: false, outcome: 'unknown' });
          expect((await request()).statusCode).toBe(403);
          expect(
            (
              await call('approve', {
                headers: ['content-type', 'accept'],
                slot: 'backend',
                endpoint: b.origin + '/v1/',
                roles: ['ui'],
                methods: ['POST'],
                auth: { kind: 'header', header: 'x-api-key', value: 'synthetic-plugin-key' },
              })
            ).statusCode,
          ).toBe(200);
          connection = (await call('list')).json()[0];
          expect((await request({}, { role: 'ui' })).json()).toMatchObject({
            ok: true,
            body: { provider: 'dictionary', value: 'HELLO' },
          });
          expect(b.requests[0].authenticated).toBe(true);
          // Deployment/library identity changes invalidate retained approvals.
          const priorScope = await pool.query('select library_id from plugin_deployment_identity');
          await pool.query('update plugin_deployment_identity set library_id=$1', [randomUUID()]);
          expect((await call('list')).json()).toEqual([]);
          expect((await request({}, { role: 'ui' })).statusCode).toBe(403);
          await pool.query('update plugin_deployment_identity set library_id=$1', [priorScope.rows[0].library_id]);
          const logout = request({ path: 'slow' }, { role: 'ui' });
          await new Promise((r) => setTimeout(r, 150));
          await auth.logout(account.token);
          expect((await logout).json()).toMatchObject({ ok: false, outcome: 'unknown' });
          expect((await call('list')).statusCode).toBe(403);
          await pool.query('delete from self_host_accounts');
          expect((await pool.query('select id from plugin_connections')).rows).toEqual([]);
        } finally {
          await app.close();
        }
      });
    } finally {
      if (previous === undefined) delete process.env.JS_PLUGIN_PRIVATE_ORIGINS;
      else process.env.JS_PLUGIN_PRIVATE_ORIGINS = previous;
      await a.close();
      await b.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
