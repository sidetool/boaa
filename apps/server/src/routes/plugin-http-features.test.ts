import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { registerPluginConnectionRoutes } from './plugin-connections';
import { pluginHttpTransport } from '../plugins/http-transport';
import { requirePluginConnectionAuthority } from '../plugins/plugin-connection-authority';
vi.mock('../plugins/http-transport', () => ({
  pluginHttpTransport: vi.fn(),
  approvePluginEndpoint: vi.fn(),
  credentialHeaderAllowed: () => false,
  privateOrigins: () => [],
}));
afterEach(() => vi.resetAllMocks());
async function fixture() {
  const scope = { accountId: randomUUID(), libraryId: randomUUID(), serverId: randomUUID() };
  const owner = { profileId: scope.accountId, installationId: randomUUID(), digest: 'a'.repeat(64), generation: 1 };
  const connection = {
    slot: 'api',
    endpoint: 'https://catalog.example/api/',
    roles: ['controller'],
    methods: ['GET'],
    headers: ['origin'],
    revision: randomUUID(),
  };
  const installation = {
    enabled: true,
    tombstone: false,
    active: owner.digest,
    revision: 1,
    manifest: {
      features: { required: ['http.json-pick', 'http.origin'], optional: [] as string[] },
      contributes: { connections: ['api'] },
      entries: { controller: { permissions: ['http.request'] }, ui: { permissions: ['http.request'] } },
    },
  };
  const grants = {
    installationId: owner.installationId,
    digest: owner.digest,
    revision: 1,
    roles: { controller: ['http.request'], ui: ['http.request'] },
  };
  const pool = {
    query: vi.fn(async (sql: string, values?: unknown[]) => ({
      rows: sql.includes('self_host_sessions')
        ? [scope]
        : sql.includes('select * from plugin_connections')
          ? values && values.length >= 7 && values[6] !== connection.revision
            ? []
            : [connection]
          : sql.includes('plugin_state_rows')
            ? [{ installation, grants }]
            : [],
    })),
  };
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: 'owner', authMethod: 'session' } as typeof req.principal;
  });
  registerPluginConnectionRoutes(
    app,
    loadConfig({ JS_PLUGIN_ORIGIN: 'https://boaa.test', DEFAULT_USER_ID: 'owner' }),
    pool as unknown as pg.Pool,
  );
  vi.mocked(pluginHttpTransport).mockImplementation(async (_i, _e, _c, _b, _a, _h, _p, _s, authorize) => {
    await authorize();
    return { ok: true, status: 200, headers: {}, body: { rows: [] } };
  });
  const call = (changes: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/plugins/connections/request',
      headers: { origin: 'https://boaa.test', 'x-boaa-plugin-host': '1', cookie: 'boaa_session=synthetic' },
      payload: {
        owner,
        requestId: randomUUID(),
        role: 'controller',
        revision: connection.revision,
        request: {
          slot: 'api',
          path: 'list',
          method: 'GET',
          response: 'json',
          headers: { origin: 'https://catalog.example' },
          pick: [['rows', '*', 'id']],
        },
        ...changes,
      },
    });
  return { app, call, pool, scope, owner, installation, grants, connection };
}
it('requires both declared features and the live caller role grant before reaching transport', async () => {
  const f = await fixture();
  try {
    for (const required of [[], ['http.json-pick'], ['http.origin']]) {
      f.installation.manifest.features.required = required;
      expect((await f.call()).statusCode).toBe(403);
    }
    expect(pluginHttpTransport).not.toHaveBeenCalled();
    f.installation.manifest.features.required = ['http.origin', 'http.json-pick'];
    expect((await f.call()).statusCode).toBe(200);
    const count = vi.mocked(pluginHttpTransport).mock.calls.length;
    f.grants.roles.controller = [];
    expect((await f.call()).statusCode).toBe(403);
    f.grants.roles.controller = ['http.request'];
    f.installation.revision = 2;
    expect((await f.call()).statusCode).toBe(403);
    f.installation.revision = 1;
    expect((await f.call({ role: 'ui' })).statusCode).toBe(403);
    expect(pluginHttpTransport).toHaveBeenCalledTimes(count);
  } finally {
    await f.app.close();
  }
});
it('checks combined features in one authority query and permits declared optional feature support', async () => {
  const f = await fixture();
  try {
    f.installation.manifest.features.required = ['http.json-pick'];
    f.installation.manifest.features.optional = ['http.origin'];
    f.pool.query.mockClear();
    await requirePluginConnectionAuthority(
      f.pool as unknown as pg.Pool,
      f.scope,
      f.owner,
      'api',
      ['controller'],
      ['http.json-pick', 'http.origin'],
    );
    expect(f.pool.query).toHaveBeenCalledTimes(1);
    f.installation.manifest.features.optional = [];
    await expect(
      requirePluginConnectionAuthority(
        f.pool as unknown as pg.Pool,
        f.scope,
        f.owner,
        'api',
        ['controller'],
        ['http.json-pick', 'http.origin'],
      ),
    ).rejects.toThrow('PLUGIN_CONNECTION_DENIED');
  } finally {
    await f.app.close();
  }
});
it('rechecks features during delayed send and rejects a stale connection revision', async () => {
  const f = await fixture();
  try {
    expect((await f.call({ revision: randomUUID() })).statusCode).toBe(403);
    // Revoke one declared feature after initial authorization but before actual send.
    vi.mocked(pluginHttpTransport).mockImplementationOnce(async (_i, _e, _c, _b, _a, _h, _p, _s, authorize) => {
      f.installation.manifest.features.required = ['http.json-pick'];
      await authorize();
      return { ok: true, status: 200, headers: {}, body: {} };
    });
    expect((await f.call()).statusCode).toBe(403);
  } finally {
    await f.app.close();
  }
});
