import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { registerPluginConnectionRoutes } from './plugin-connections';
import { loadConfig } from '../config';
import { SELF_HOST_SESSION_COOKIE } from '../auth-cookie';
import { pluginCoverTransport } from '../plugins/cover-transport';
vi.mock('../plugins/cover-transport', () => ({ pluginCoverTransport: vi.fn() }));
vi.mock('../plugins/image-thumbnail', () => ({
  pluginImageThumbnail: vi.fn(async () => ({ mime: 'image/webp', data: 'eA==', width: 1, height: 1 })),
}));
afterEach(() => vi.clearAllMocks());
async function fixture() {
  const scope = { accountId: randomUUID(), libraryId: randomUUID(), serverId: randomUUID() };
  const owner = { profileId: scope.accountId, installationId: randomUUID(), digest: 'a'.repeat(64), generation: 1 };
  const connection = {
    slot: 'covers',
    endpoint: 'https://images.example.test/covers/',
    roles: ['ui'],
    methods: ['GET'],
    revision: randomUUID(),
  };
  const installation = {
    enabled: true,
    tombstone: false,
    active: owner.digest,
    revision: 1,
    manifest: {
      features: { required: ['ui.images'] },
      contributes: { connections: ['covers'] },
      entries: { ui: { permissions: ['http.request'] } },
    },
  };
  const grants = {
    installationId: owner.installationId,
    digest: owner.digest,
    revision: 1,
    roles: { ui: ['http.request'] },
  };
  const pool = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('self_host_sessions')
        ? [scope]
        : sql.includes('select * from plugin_connections')
          ? [connection]
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
  const call = (action: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/connections/${action}`,
      headers: {
        origin: 'https://boaa.test',
        'x-boaa-plugin-host': '1',
        cookie: `${SELF_HOST_SESSION_COOKIE}=synthetic`,
      },
      payload: { owner, ...body },
    });
  const image = (request: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    call('image', {
      requestId: randomUUID(),
      revision: connection.revision,
      request: { slot: 'covers', path: 'one.png', ...request },
      ...extra,
    });
  return { app, call, image, connection, installation, grants, owner };
}
it('authorizes exact UI slot, GET, feature, grants and current revision even on a cached acquisition', async () => {
  const f = await fixture();
  try {
    expect((await f.image({ cachedRevision: f.connection.revision })).json()).toEqual({
      notModified: true,
      revision: f.connection.revision,
    });
    expect(pluginCoverTransport).not.toHaveBeenCalled();
    expect((await f.image({ slot: 'other', cachedRevision: f.connection.revision })).statusCode).toBe(403);
    expect((await f.image({}, { revision: randomUUID() })).statusCode).toBe(403);
    f.connection.roles = ['controller'];
    expect((await f.image()).statusCode).toBe(403);
    f.connection.roles = ['ui'];
    f.connection.methods = ['POST'];
    expect((await f.image()).statusCode).toBe(403);
    f.connection.methods = ['GET'];
    f.installation.manifest.features.required = [];
    expect((await f.image()).statusCode).toBe(403);
    f.installation.manifest.features.required = ['ui.images'];
    f.grants.roles.ui = [];
    expect((await f.image({ cachedRevision: f.connection.revision })).statusCode).toBe(403);
    f.grants.roles.ui = ['http.request'];
    f.installation.enabled = false;
    expect((await f.image()).statusCode).toBe(403);
    expect(pluginCoverTransport).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});
it('forwards only a contained relative path, transforms bytes and fences revision after download', async () => {
  const f = await fixture();
  vi.mocked(pluginCoverTransport).mockResolvedValue({ mime: 'image/png', data: 'eA==' });
  try {
    expect((await f.image({ path: 'one.png?size=2' })).json()).toMatchObject({
      mime: 'image/webp',
      width: 1,
      revision: f.connection.revision,
    });
    expect(vi.mocked(pluginCoverTransport).mock.calls[0][0]).toBe('https://images.example.test/covers/one.png?size=2');
    expect((await f.image({ path: '../secret' })).statusCode).toBe(403);
    vi.mocked(pluginCoverTransport).mockImplementationOnce(async () => {
      f.connection.revision = randomUUID();
      return { mime: 'image/png', data: 'eA==' };
    });
    expect((await f.image()).statusCode).toBe(403);
  } finally {
    await f.app.close();
  }
});
it('rejects requests arriving after cancellation and cancels a known in-flight image ID', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    await f.call('cancel', { requestId });
    expect((await f.image({}, { requestId })).statusCode).toBe(403);
    let ready!: () => void;
    const started = new Promise<void>((r) => {
      ready = r;
    });
    vi.mocked(pluginCoverTransport).mockImplementationOnce(
      (_u, _b, _o, signal) =>
        new Promise((_r, reject) => {
          ready();
          signal.addEventListener('abort', () => reject(Error('CANCELLED')), { once: true });
        }),
    );
    const id = randomUUID(),
      pending = f.image({}, { requestId: id }).then((r) => r);
    await started;
    await f.call('cancel', { requestId: id });
    expect((await pending).statusCode).toBe(403);
  } finally {
    await f.app.close();
  }
});
