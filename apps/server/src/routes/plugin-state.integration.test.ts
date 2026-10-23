import { afterAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { registerPluginStateRoutes } from './plugin-state';
import { loadConfig } from '../config';
import { migrateDatabase } from '../db/migrate';
import { seedDefaultUser } from '../db/pool';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../services/self-host-auth-service';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness';
import { SELF_HOST_SESSION_COOKIE, requestCookie } from '../auth-cookie';
import { pluginScope } from '../plugins/plugin-scope';
import { ServerPluginDatabase } from '../../../../src/extensions/platform/server-plugin-database';
import { PlatformPluginStore } from '../../../../src/extensions/platform/plugin-store';
import { scopeKey } from '../../../../src/extensions/ui/store-model';
import { single, approve, id } from '../../../../src/extensions/platform/store-test-fixture';
const harness = await startPostgresIntegrationHarness();
afterAll(() => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
it.skipIf(!harness)(
  'commits private account data atomically, synchronizes browsers, isolates accounts and retires connections only on successful change',
  async () => {
    await withPostgresSchema(harness!, 'plugin_state', async (pool) => {
      await migrateDatabase(pool);
      await seedDefaultUser(pool, 'owner');
      const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'owner');
      const owner = await auth.register({ username: 'state-owner', password: 'Synthetic-password-2026!' });
      const invitation = await auth.invite('owner', 'state-member');
      await auth.redeem(invitation.token, 'Synthetic-member-2026!', 'invite', 'test');
      const member = await auth.login({
        username: 'state-member',
        password: 'Synthetic-member-2026!',
        throttleKey: 'test',
      });
      const identity = (await pluginScope(pool, owner.token, 'owner'))!;
      const scope = { kind: 'remote' as const, profileId: identity.accountId, ...identity };
      const app = Fastify();
      app.addHook('onRequest', async (req) => {
        const account = await auth.authenticateSession(requestCookie(req, SELF_HOST_SESSION_COOKIE));
        if (account) req.principal = { ...account, authMethod: 'session' };
      });
      registerPluginStateRoutes(app, loadConfig({ JS_PLUGIN_ORIGIN: 'https://boaa.test' }), pool);
      const headers = (token = owner.token) => ({
        origin: 'https://boaa.test',
        'x-boaa-plugin-host': '1',
        cookie: `${SELF_HOST_SESSION_COOKIE}=${token}`,
      });
      const transport: typeof fetch = async (url, init) => {
        const response = await app.inject({
          url: String(url),
          method: (init?.method ?? 'GET') as 'GET' | 'POST',
          headers: { ...headers(), ...(init?.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      };
      const firstDb = new ServerPluginDatabase({ scope: scopeKey(scope), transport }),
        secondDb = new ServerPluginDatabase({ scope: scopeKey(scope), transport });
      const first = new PlatformPluginStore(scope, { database: firstDb }),
        second = new PlatformPluginStore(scope, { database: secondDb });
      try {
        const review = await first.inspect(single(), 'single-js', 'local-file');
        const installed = await first.install(review, approve(review));
        await secondDb.refresh();
        expect((await second.list())[0]).toEqual(installed);
        const connectionId = randomUUID();
        await pool.query(
          `insert into plugin_connections(id,account_id,scope_key,headers,profile_id,installation_id,digest,generation,slot,endpoint,roles,methods,revision) values($1,$2,$3,'[]',$2,$4,$5,$6,'test','https://api.example.test/','["controller"]','["GET"]',$7)`,
          [
            connectionId,
            identity.accountId,
            `${identity.serverId}:${identity.libraryId}`,
            installed.installationId,
            installed.active,
            installed.revision,
            randomUUID(),
          ],
        );
        const memberState = await app.inject({ url: '/api/plugins/state', headers: headers(member.token) });
        expect(memberState.statusCode).toBe(200);
        expect(memberState.json()).toEqual({ revision: 0, changes: [] });
        const cross = await app.inject({
          method: 'POST',
          url: '/api/plugins/state',
          headers: headers(member.token),
          payload: {
            expectedRevision: 0,
            changes: [
              {
                store: 'preferences',
                key: [scopeKey(scope), 'reader-input'],
                value: { scope: scopeKey(scope), key: 'reader-input', value: null },
              },
            ],
          },
        });
        expect(cross.statusCode).toBe(400);
        const forged = await app.inject({
          method: 'POST',
          url: '/api/plugins/state',
          headers: headers(),
          payload: {
            expectedRevision: firstDb.getRevision(),
            changes: [
              {
                store: 'installations',
                key: [scopeKey(scope), id],
                value: {
                  ...installed,
                  revision: installed.revision + 1,
                  manifest: { ...installed.manifest, extension: { ...installed.manifest!.extension, name: 'forged' } },
                },
              },
            ],
          },
        });
        expect(forged.statusCode).toBe(400);
        expect((await pool.query('select id from plugin_connections')).rows).toHaveLength(1);
        await firstDb.writePreference('reader-input', null);
        await expect(second.disable(id, installed.revision)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
        expect((await pool.query('select id from plugin_connections')).rows).toHaveLength(1);
        await second.disable(id, installed.revision);
        expect((await pool.query('select id from plugin_connections')).rows).toHaveLength(0);
        await firstDb.refresh();
        expect((await first.list())[0].enabled).toBe(false);
        expect(
          (await app.inject({ url: '/api/plugins/state', headers: { ...headers(), origin: 'https://evil.test' } }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: '/api/plugins/state',
              headers: { origin: 'https://boaa.test', 'x-boaa-plugin-host': '1' },
            })
          ).statusCode,
        ).toBe(403);
        const unchanged = await app.inject({
          url: `/api/plugins/state?since=${firstDb.getRevision()}`,
          headers: headers(),
        });
        expect(unchanged.json().changes).toEqual([]);
        const durable = await pool.query('select store,value from plugin_state_rows where value is not null');
        expect(durable.rows.some((row) => row.store === 'archives' && typeof row.value.blobBase64 === 'string')).toBe(
          true,
        );
        expect(durable.rows.some((row) => row.store === 'runtime-markers')).toBe(false);
        // Compaction bounds deleted-key history; old browsers receive an authoritative replacement snapshot.
        await pool.query(
          `insert into plugin_state_rows(account_id,library_id,store,row_key,value,revision) select $1,$2,'kv','retired-'||i::text,null,1 from generate_series(1,2049) i`,
          [identity.accountId, identity.libraryId],
        );
        await firstDb.writePreference('reader-input', null);
        const compacted = await app.inject({ url: '/api/plugins/state?since=1', headers: headers() });
        expect(compacted.json().reset).toBe(true);
        expect(compacted.json().changes.every((change: { value?: unknown }) => change.value !== undefined)).toBe(true);
        expect(
          (await pool.query('select count(*) as count from plugin_state_rows where value is null')).rows[0].count,
        ).toBe('0');
      } finally {
        await first.close();
        await second.close();
        await app.close();
      }
    });
  },
  60000,
);
