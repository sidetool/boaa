import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerServerManagement } from './server-management';
import { atomicJson } from '../../../../scripts/release/files.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-management-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = Fastify();
  cleanup.push(() => app.close());
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer owner') return reply.code(401).send({ error: 'unauthorized' });
  });
  await registerServerManagement(app, [{ getJobCounts: async () => ({ active: 0, waiting: 0 }) }], directory);
  app.post('/api/books', async () => ({ ok: true }));
  const status = {
    available: true,
    currentVersion: '1.0.0',
    channel: 'stable',
    phase: 'idle',
    busy: false,
    components: [],
  };
  await atomicJson(path.join(directory, 'status.json'), { heartbeat: Date.now(), status });
  return { app, directory, status };
}
const headers = { authorization: 'Bearer owner' };
describe('server management mailbox', () => {
  it('requires authentication and rejects arbitrary commands/URLs', async () => {
    const { app, directory } = await fixture();
    expect(
      (await app.inject({ method: 'POST', url: '/api/admin/system/requests', payload: { action: 'update' } }))
        .statusCode,
    ).toBe(401);
    for (const payload of [
      { action: 'shell', command: 'whoami' },
      { action: 'update', url: 'https://untrusted.invalid' },
      { action: 'component', componentId: '../api', enabled: true },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/admin/system/requests', headers, payload })).statusCode,
      ).toBe(400);
    await expect(readFile(path.join(directory, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes one complete request and rejects a concurrent duplicate', async () => {
    const { app, directory } = await fixture();
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: '/api/admin/system/requests', headers, payload: { action: 'update' } }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const message = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
    expect(message.request).toEqual({ action: 'update' });
    expect(message.id).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('stale updater status never authorizes an install', async () => {
    const { app, directory, status } = await fixture();
    await atomicJson(path.join(directory, 'status.json'), { heartbeat: Date.now() - 60_000, status });
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/requests',
      headers,
      payload: { action: 'update' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'updater_unavailable' });
  });
  it('maintenance stops new app work while retaining the progress endpoint', async () => {
    const { app, directory } = await fixture();
    await atomicJson(path.join(directory, 'maintenance.json'), { id: 'fixture', expiresAt: Date.now() + 20_000 });
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).leaseId, {
        timeout: 5000,
      })
      .toBe('fixture');
    expect((await app.inject({ method: 'POST', url: '/api/books', headers, payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ url: '/api/admin/system', headers })).statusCode).toBe(200);
    const activity = JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8'));
    expect(activity.leaseId).toBe('fixture');
    expect(activity.idle).toBe(true);
  });
  it('keeps application requests blocked during manual recovery even after a lease expires', async () => {
    const { app, directory, status } = await fixture();
    await atomicJson(path.join(directory, 'status.json'), {
      heartbeat: Date.now(),
      status: { ...status, phase: 'recovery-required' },
    });
    await expect
      .poll(async () => (await app.inject({ method: 'POST', url: '/api/books', headers, payload: {} })).statusCode, {
        timeout: 5000,
      })
      .toBe(503);
    expect((await app.inject({ url: '/api/admin/system', headers })).statusCode).toBe(200);
  });
});
