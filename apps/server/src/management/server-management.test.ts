import http from 'node:http';
import { once } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
async function fixture(beforeManagement?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-management-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.principal = { userId: 'fixture-admin', role: 'admin', authMethod: 'legacy-token' };
  });
  cleanup.push(() => app.close());
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer owner') return reply.code(401).send({ error: 'unauthorized' });
  });
  if (beforeManagement) app.addHook('onRequest', beforeManagement);
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
  it('counts background generation as activity and blocks new work during maintenance', async () => {
    const { app, directory } = await fixture();
    const release = app.beginBackgroundWork!();
    expect(release).toBeTypeOf('function');
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).idle, {
        timeout: 5000,
      })
      .toBe(false);
    await atomicJson(path.join(directory, 'maintenance.json'), {
      id: 'background-check',
      expiresAt: Date.now() + 20_000,
    });
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).leaseId, {
        timeout: 5000,
      })
      .toBe('background-check');
    expect(app.beginBackgroundWork!()).toBeUndefined();
    release!();
    release!();
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).idle, {
        timeout: 5000,
      })
      .toBe(true);
  });
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

it('does not admit or retain a request disconnected during an earlier async auth hook', async () => {
  let release!: () => void;
  let entered!: (value: { reply: FastifyReply }) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<{ reply: FastifyReply }>((resolve) => {
    entered = resolve;
  });
  const { app, directory } = await fixture(async (_request, reply) => {
    entered({ reply });
    await gate;
  });
  let handled = 0;
  app.get('/api/probe', async () => {
    handled++;
    return { ok: true };
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = http.get(origin + '/api/probe', { headers });
  request.on('error', () => undefined);
  try {
    const { reply } = await started;
    const closed = once(reply.raw, 'close');
    request.destroy();
    await closed;
    expect(reply.raw.destroyed).toBe(true);
    const releasedAt = Date.now();
    release();
    await expect
      .poll(
        async () => {
          const activity = JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8'));
          return { fresh: activity.timestamp > releasedAt, idle: activity.idle };
        },
        { timeout: 5000 },
      )
      .toEqual({ fresh: true, idle: true });
    expect(handled).toBe(0);
  } finally {
    release();
    request.destroy();
  }
});

it('keeps a live application request busy until its response completes', async () => {
  const { app, directory } = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.get('/api/probe', async () => {
    started();
    await gate;
    return { ok: true };
  });
  const response = app.inject({ url: '/api/probe', headers });
  // LightMyRequest starts lazily when consumed.
  const completed = response.then((value) => value);
  try {
    await entered;
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).idle, {
        timeout: 5000,
      })
      .toBe(false);
    release();
    expect((await completed).statusCode).toBe(200);
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(directory, 'activity.json'), 'utf8')).idle, {
        timeout: 5000,
      })
      .toBe(true);
  } finally {
    release();
  }
});
