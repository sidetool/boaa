import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { registerAuthHook } from '../auth';
import { loadConfig } from '../config';
import type { SelfHostAuthService } from '../services/self-host-auth-service';
import { registerPluginRuntimeRoutes } from './plugin-runtime';

const token = 'existing-session';
const scope = {
  serverId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  libraryId: '00000000-0000-4000-8000-000000000003',
};
const auth = {
  authenticateSession: async (value?: string) => (value === token ? { id: 'owner' } : undefined),
  setupRequired: async () => false,
} as unknown as SelfHostAuthService;
const pool = {
  query: async (_sql: string, values: string[]) => ({
    rows: values[0] === createHash('sha256').update(token).digest('hex') ? [scope] : [],
  }),
} as unknown as pg.Pool;

it('retains legacy cookie scope and serves runtime assets outside the API cookie path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boaa-plugin-auth-'));
  const app = Fastify();
  try {
    for (const file of ['view-bootstrap.js', 'controller-worker.js', 'quickjs.wasm'])
      await writeFile(join(directory, file), 'fixture');
    const config = loadConfig({ SERVER_EXPOSURE: 'loopback', JS_PLUGIN_ORIGIN: 'http://127.0.0.1:1442' });
    await registerAuthHook(app, config, auth);
    await registerPluginRuntimeRoutes(app, config, pool, pathToFileURL(directory + '/'));
    const old = await app.inject({ url: '/api/plugins/context', headers: { cookie: `moya_session=${token}` } });
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ ...scope, origin: 'http://127.0.0.1:1442' });
    expect(old.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('boaa_session=')]));
    const current = await app.inject({ url: '/api/plugins/context', headers: { cookie: `boaa_session=${token}` } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(old.json());
    expect(current.headers['set-cookie']).toBeUndefined();
    expect((await app.inject('/api/plugins/context')).statusCode).toBe(401);
    for (const [path, type] of [
      ['controller-worker.js', 'application/javascript'],
      ['quickjs.wasm', 'application/wasm'],
      ['shell', 'text/html'],
    ]) {
      const asset = await app.inject('/plugin-runtime/' + path);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain(type);
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not mistake an unauthenticated 401 for an enabled optional plugin deployment', async () => {
  const app = Fastify();
  try {
    const config = loadConfig({ SERVER_EXPOSURE: 'loopback' });
    await registerAuthHook(app, config, auth);
    await registerPluginRuntimeRoutes(app, config, pool, new URL('file:///nonexistent/'));
    expect((await app.inject('/api/plugins/context')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/plugins/context', headers: { cookie: `moya_session=${token}` } })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
