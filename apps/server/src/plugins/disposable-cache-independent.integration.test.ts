import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { disposableCache } from './disposable-cache';
import { cacheAuthority } from './cache-authority';
import { registerPluginCacheRoutes } from '../routes/plugin-cache';
import { migrateDatabase } from '../db/migrate';
import { seedDefaultUser } from '../db/pool';
import { SelfHostAuthService, PostgresSelfHostAuthStore } from '../services/self-host-auth-service';
import { accountIdentity, pluginScope } from './plugin-scope';
import { SELF_HOST_SESSION_COOKIE, requestCookie } from '../auth-cookie';
import { loadConfig } from '../config';
import {
  PLUGIN_CACHE_LIMITS as limits,
  type PluginCacheRequest,
} from '../../../../packages/extension-contracts/plugin-cache';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness';

const harness = await startPostgresIntegrationHarness();
let pool: pg.Pool, release!: () => void, lifetime: Promise<void>;
let auth: SelfHostAuthService, token: string, otherToken: string;
let scope: { accountId: string; libraryId: string; serverId: string }, otherScope: typeof scope;
let installationId: string, owner: { profileId: string; installationId: string; digest: string; generation: number };
let clock = Date.now();
const pluginId = 'org.example.disposable-cache';
const manifest = {
  features: { required: ['cache.own'], optional: [] },
  entries: { controller: { permissions: ['storage.own', 'home.feed'] }, ui: { permissions: ['storage.own'] } },
  contributes: { homeSections: [{ id: 'popular', title: 'Neutral fixture' }] },
};
const grants = { controller: ['storage.own', 'home.feed'], ui: ['storage.own'] };
const set = (
  key: string,
  value: PluginCacheRequest['value'],
  ttlSeconds = 300,
  staleSeconds = 86400,
): PluginCacheRequest => ({ action: 'set', key, value, ttlSeconds, staleSeconds });
const get = (key: string): PluginCacheRequest => ({ action: 'get', key });
async function cache(input: PluginCacheRequest, kind: 'data' | 'home' = 'data') {
  return disposableCache(pool, { ...scope, installationId }, kind, input, (db) =>
    cacheAuthority(db, scope, owner, { kind, role: 'controller', key: input.key }),
  );
}
async function insertInstallation(account: typeof scope, id: string, digest = owner.digest) {
  await pool.query(
    'insert into plugin_state_versions(account_id,library_id,revision) values($1,$2,1) on conflict do nothing',
    [account.accountId, account.libraryId],
  );
  const rowKey = JSON.stringify([account.accountId, id]);
  const install = {
    pluginId,
    installationId: id,
    enabled: true,
    tombstone: false,
    active: digest,
    revision: 1,
    manifest,
  };
  for (const [store, value] of [
    ['installations', install],
    ['grants', { installationId: id, digest, revision: 1, roles: grants }],
  ] as const)
    await pool.query(
      'insert into plugin_state_rows(account_id,library_id,store,row_key,value,revision) values($1,$2,$3,$4,$5,1)',
      [account.accountId, account.libraryId, store, rowKey, JSON.stringify(value)],
    );
}
async function connection() {
  const revision = randomUUID();
  await pool.query(
    `insert into plugin_connections(id,account_id,scope_key,headers,profile_id,installation_id,digest,generation,slot,endpoint,roles,methods,revision)
    values($1,$2,$3,'["accept"]',$2,$4,$5,1,'api','https://api.example.test/v1/','["controller","ui"]','["GET"]',$6)`,
    [randomUUID(), scope.accountId, scope.serverId + ':' + scope.libraryId, installationId, owner.digest, revision],
  );
  return revision;
}
beforeAll(async () => {
  if (!harness) return;
  let ready!: () => void, fail!: (e: unknown) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifetime = withPostgresSchema(harness, 'cache_independent', async (p) => {
    pool = p;
    await migrateDatabase(pool);
    await seedDefaultUser(pool, 'cache-owner');
    auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'cache-owner');
    token = (await auth.register({ username: 'cache-owner', password: 'Synthetic-cache-owner-2026!' })).token;
    const invitation = await auth.invite('cache-owner', 'cache-other');
    await auth.redeem(invitation.token, 'Synthetic-cache-other-2026!', 'invite', 'test');
    otherToken = (
      await auth.login({ username: 'cache-other', password: 'Synthetic-cache-other-2026!', throttleKey: 'test' })
    ).token;
    scope = (await pluginScope(pool, token, 'cache-owner'))!;
    otherScope = (await pluginScope(pool, otherToken, (await auth.authenticateSession(otherToken))!.userId))!;
    await accountIdentity(pool, 'cache-owner');
    ready();
    await held;
  });
  void lifetime.catch(fail);
  await started;
}, 45000);
beforeEach(async () => {
  if (!harness) return;
  await pool.query('delete from plugin_cache_entries');
  await pool.query('delete from plugin_connections');
  await pool.query('delete from plugin_state_rows');
  installationId = randomUUID();
  owner = { profileId: scope.accountId, installationId, digest: 'a'.repeat(64), generation: 1 };
  await insertInstallation(scope, installationId);
  await insertInstallation(otherScope, randomUUID());
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  release?.();
  try {
    await lifetime;
  } finally {
    await harness?.stop();
  }
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);

it.skipIf(!harness)(
  'persists independently of clients, observes exact freshness/expiry and never touches permanent KV',
  async () => {
    await pool.query(
      `insert into plugin_state_rows(account_id,library_id,store,row_key,value,revision) values($1,$2,'kv','["permanent"]','{"value":"keep","revision":7}',1)`,
      [scope.accountId, scope.libraryId],
    );
    const before = (await pool.query("select value,revision from plugin_state_rows where store='kv'")).rows;
    const at = clock;
    await cache(set('stable', { items: ['one'] }, 60, 60));
    expect(await cache(get('stable'))).toEqual({
      found: true,
      value: { items: ['one'] },
      savedAt: at,
      freshUntil: at + 60000,
      expiresAt: at + 120000,
    });
    // New connection/client, no browser or process-local client cache used.
    const client = await pool.connect();
    client.release();
    clock = at + 60000;
    expect(await cache(get('stable'))).toMatchObject({ found: true, savedAt: at, freshUntil: clock });
    clock = at + 119999;
    expect((await cache(get('stable'))).found).toBe(true);
    clock = at + 120000;
    expect(await cache(get('stable'))).toEqual({ found: false });
    expect((await pool.query("select value,revision from plugin_state_rows where store='kv'")).rows).toEqual(before);
  },
);
it.skipIf(!harness)('shares home/data count budget and evicts oldest saved rather than last accessed', async () => {
  await cache(set('oldest', 1));
  clock++;
  await cache(set('popular', { items: [] }), 'home');
  for (let i = 0; i < limits.pluginEntries - 2; i++) {
    clock++;
    await cache(set('key-' + i, i));
  }
  expect((await cache(get('oldest'))).found).toBe(true); // read must not promote saved-at order
  clock++;
  await cache(set('newest', 2));
  expect(await cache(get('oldest'))).toEqual({ found: false });
  expect((await cache(get('popular'), 'home')).found).toBe(true);
  expect(Number((await pool.query('select count(*) count from plugin_cache_entries')).rows[0].count)).toBe(
    limits.pluginEntries,
  );
  await cache({ action: 'remove', key: 'popular' }); // another namespace cannot remove home
  expect((await cache(get('popular'), 'home')).found).toBe(true);
});
it.skipIf(!harness)(
  'serializes simultaneous writers within plugin byte budget and preserves existing value on oversized rollback',
  async () => {
    vi.mocked(Date.now).mockImplementation(() => ++clock);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => cache(set('payload-' + i, 'x'.repeat(limits.entryBytes - 100)))),
    );
    const row = (await pool.query('select sum(bytes) bytes,count(*) count from plugin_cache_entries')).rows[0];
    expect(Number(row.bytes)).toBeLessThanOrEqual(limits.pluginBytes);
    expect(Number(row.count)).toBe(5);
    await cache(set('stable', 'good'));
    // Repository is also defensive when called by trusted host/home code rather than public validator.
    await expect(cache(set('stable', 'x'.repeat(limits.entryBytes)))).rejects.toThrow('CACHE_LIMIT');
    expect(await cache(get('stable'))).toMatchObject({ found: true, value: 'good' });
  },
);
it.skipIf(!harness)('rolls back a write if authority changes between first check and commit', async () => {
  await cache(set('stable', 'good'));
  let checks = 0;
  await expect(
    disposableCache(pool, { ...scope, installationId }, 'data', set('stable', 'bad'), async () =>
      ++checks === 1 ? 'original' : 'changed',
    ),
  ).rejects.toThrow('CACHE_AUTHORITY_CHANGED');
  expect(await cache(get('stable'))).toMatchObject({ found: true, value: 'good' });
});
it.skipIf(!harness)(
  'invalidates all connection-bound data on revision/endpoint/roles/methods/headers and grant/package changes',
  async () => {
    await connection();
    for (const [field, value] of [
      ['revision', randomUUID()],
      ['endpoint', 'https://api.example.test/v2/'],
      ['roles', '["controller"]'],
      ['methods', '["GET","POST"]'],
      ['headers', '["accept","content-type"]'],
    ]) {
      await cache(set('stable', 'old'));
      await pool.query(`update plugin_connections set ${field}=$1 where installation_id=$2`, [value, installationId]);
      expect(await cache(get('stable'))).toEqual({ found: false });
    }
    await cache(set('stable', 'old'));
    await pool.query('delete from plugin_connections where installation_id=$1', [installationId]);
    expect(await cache(get('stable'))).toEqual({ found: false });
    await cache(set('stable', 'old'));
    await pool.query(
      `update plugin_state_rows set value=jsonb_set(value,'{roles,controller}','[]') where store='grants' and account_id=$1`,
      [scope.accountId],
    );
    await expect(cache(get('stable'))).rejects.toThrow('CACHE_DENIED');
    await pool.query(
      `update plugin_state_rows set value=jsonb_set(value,'{roles}',$2::jsonb) where store='grants' and account_id=$1`,
      [scope.accountId, JSON.stringify(grants)],
    );
    await pool.query(
      `update plugin_state_rows set value=jsonb_set(value,'{active}','"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"') where store='installations' and account_id=$1`,
      [scope.accountId],
    );
    await expect(cache(get('stable'))).rejects.toThrow('CACHE_DENIED');
  },
);
it.skipIf(!harness)(
  'server route checks authenticated account, origin, role/feature and owner before any cache hit',
  async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      const account = await auth.authenticateSession(requestCookie(req, SELF_HOST_SESSION_COOKIE));
      if (account) req.principal = { ...account, authMethod: 'session' };
    });
    registerPluginCacheRoutes(app, loadConfig({ JS_PLUGIN_ORIGIN: 'https://boaa.test' }), pool);
    const request = (body: unknown, extra: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/plugins/cache',
        headers: {
          origin: 'https://boaa.test',
          'x-boaa-plugin-host': '1',
          cookie: `${SELF_HOST_SESSION_COOKIE}=${token}`,
          ...extra,
        },
        payload: body as object,
      });
    const envelope = { owner, kind: 'data', role: 'controller', request: set('stable', { value: 'good' }) };
    try {
      expect((await request(envelope)).statusCode).toBe(200);
      expect((await request({ ...envelope, request: get('stable') })).json()).toMatchObject({ found: true });
      expect(
        (await request({ ...envelope, request: get('stable') }, { origin: 'https://untrusted.test' })).statusCode,
      ).toBe(403);
      expect(
        (
          await request(
            { ...envelope, request: get('stable') },
            { cookie: `${SELF_HOST_SESSION_COOKIE}=${otherToken}` },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await request({ ...envelope, owner: { ...owner, generation: 2 }, request: get('stable') })).statusCode,
      ).toBe(403);
      expect((await request({ ...envelope, kind: 'home', role: 'ui', request: get('popular') })).statusCode).toBe(403);
      expect((await request({ ...envelope, kind: 'home', request: get('undeclared') })).statusCode).toBe(403);
      await pool.query(
        `update plugin_state_rows set value=jsonb_set(value,'{manifest,features,required}','[]') where store='installations' and account_id=$1`,
        [scope.accountId],
      );
      expect((await request({ ...envelope, request: get('stable') })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  },
);
it.skipIf(!harness)(
  'enforces account budget across installations without borrowing the separate image bucket or another account',
  async () => {
    const otherInstall = randomUUID();
    // Synthetic historic entries from many installations, each under its own256KiB budget.
    const value = JSON.stringify('x'.repeat(32 * 1024 - 128));
    await pool.query(
      `insert into plugin_cache_entries(account_id,library_id,installation_id,authority,kind,cache_key,value,bytes,saved_at,fresh_until,expires_at)
    select $1,$2,md5('installation-'||(n/8)::text)::uuid,'fixture','data','key-'||n,$3::jsonb,octet_length($3::text)+octet_length('key-'||n),$4::bigint+n,$4::bigint+100000,$4::bigint+200000 from generate_series(1,280) n`,
      [scope.accountId, scope.libraryId, value, clock - 1000],
    );
    await pool.query(
      `insert into plugin_cache_entries(account_id,library_id,installation_id,authority,kind,cache_key,value,bytes,saved_at,fresh_until,expires_at)
    values($1,$2,$3,'fixture','data','other','"keep"',11,$4,$4::bigint+100000,$4::bigint+200000)`,
      [otherScope.accountId, otherScope.libraryId, otherInstall, clock],
    );
    await cache(set('current', 'new'));
    const totals = (
      await pool.query(
        `select account_id,sum(bytes) bytes from plugin_cache_entries where kind<>'image' group by account_id`,
      )
    ).rows;
    expect(Number(totals.find((r) => r.account_id === scope.accountId).bytes)).toBeLessThanOrEqual(limits.accountBytes);
    expect(Number(totals.find((r) => r.account_id === otherScope.accountId).bytes)).toBe(11);
    const authorize = (db: Pick<pg.Pool, 'query'>) => cacheAuthority(db, scope, owner);
    await disposableCache(pool, { ...scope, installationId }, 'image', set('art', 'i'.repeat(600000)), authorize);
    expect((await cache(get('current'))).found).toBe(true);
    expect(
      Number(
        (
          await pool.query("select sum(bytes) bytes from plugin_cache_entries where account_id=$1 and kind='image'", [
            scope.accountId,
          ])
        ).rows[0].bytes,
      ),
    ).toBeGreaterThan(limits.pluginBytes);
  },
);
