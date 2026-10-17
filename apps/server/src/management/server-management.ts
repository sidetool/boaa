import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Queue } from 'bullmq';
import type { ServerManagementStatus } from '../../../../packages/contracts/server-management.js';
import { atomicJson, readJson, validateRequest } from '../../../../scripts/release/files.mjs';

const idleStatus = (): ServerManagementStatus => ({
  available: false,
  reason: 'updater_unconfigured',
  currentVersion: process.env.BOAA_RELEASE_VERSION || 'unknown',
  channel: 'stable',
  phase: 'idle',
  busy: false,
  components: [],
});
const phases = new Set([
  'idle',
  'checking',
  'downloading',
  'preflight',
  'backup',
  'applying',
  'verifying',
  'complete',
  'failed',
  'rolling-back',
  'recovery-required',
]);
interface Lease {
  id: string;
  expiresAt: number;
}
interface SavedStatus {
  heartbeat: number;
  status: ServerManagementStatus;
}

export async function registerServerManagement(
  app: FastifyInstance,
  queues: Pick<Queue, 'getJobCounts'>[],
  directory = process.env.BOAA_UPDATER_MAILBOX,
) {
  let lease: Lease | undefined;
  let requests = 0;
  let ticking = false;
  let recoveryRequired = false;
  const tracked = new WeakSet<FastifyRequest>();
  const exempt = (url: string) =>
    /^(?:\/api)?\/(?:admin\/system(?:\/|$)|health$|ready$|auth\/)/.test(url.split('?')[0]);
  const activeLease = () => lease && lease.expiresAt > Date.now() && lease.expiresAt < Date.now() + 300_000;
  async function status(): Promise<ServerManagementStatus> {
    if (!directory) return idleStatus();
    try {
      const saved = await readJson<SavedStatus>(path.join(directory, 'status.json'));
      const value = saved.status;
      if (
        !value ||
        !phases.has(value.phase) ||
        !Array.isArray(value.components) ||
        !['stable', 'beta'].includes(value.channel)
      )
        throw new Error('management_state_invalid');
      const fresh =
        Number.isFinite(saved.heartbeat) &&
        Date.now() - saved.heartbeat < 20_000 &&
        saved.heartbeat <= Date.now() + 5_000;
      return { ...value, available: fresh && value.available, ...(fresh ? {} : { reason: 'updater_unavailable' }) };
    } catch {
      return { ...idleStatus(), reason: 'updater_unavailable' };
    }
  }
  async function tick() {
    if (!directory || ticking) return;
    ticking = true;
    try {
      const candidate = await readJson<Lease | null>(path.join(directory, 'maintenance.json'), null, 4096);
      lease =
        candidate && typeof candidate.id === 'string' && Number.isFinite(candidate.expiresAt) ? candidate : undefined;
      const saved = await readJson<SavedStatus | null>(path.join(directory, 'status.json'), null);
      recoveryRequired = saved?.status?.phase === 'recovery-required';
      const counts = await Promise.all(
        queues.map((queue) => queue.getJobCounts('active', 'waiting', 'delayed', 'paused', 'waiting-children')),
      );
      await atomicJson(
        path.join(directory, 'activity.json'),
        {
          timestamp: Date.now(),
          leaseId: activeLease() ? lease?.id : undefined,
          idle: requests === 0 && counts.every((count) => Object.values(count).every((value) => value === 0)),
          version: process.env.BOAA_RELEASE_VERSION || 'unknown',
        },
        0o660,
      );
    } catch {
      // A missing or invalid heartbeat cannot authorize an update.
    } finally {
      ticking = false;
    }
  }
  if (directory) {
    await tick();
    const timer = setInterval(() => void tick(), 1000);
    timer.unref();
    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
    app.addHook('onRequest', async (request, reply) => {
      if (exempt(request.url) || request.method === 'OPTIONS') return;
      if (recoveryRequired || activeLease())
        return reply.code(503).header('Retry-After', '5').send({ error: 'server_maintenance' });
      requests++;
      tracked.add(request);
      const done = () => {
        if (tracked.delete(request)) requests--;
      };
      reply.raw.once('close', done);
      reply.raw.once('finish', done);
    });
  }
  app.get('/api/admin/system', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return status();
  });
  app.post('/api/admin/system/requests', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let input;
    try {
      input = validateRequest(request.body);
    } catch {
      return reply.code(400).send({ error: 'management_request_invalid' });
    }
    // Require a non-simple JSON request; existing authentication and CORS hooks apply.
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
      return reply.code(415).send({ error: 'management_request_invalid' });
    const current = await status();
    if (!directory || !current.available)
      return reply.code(503).send({ error: current.reason || 'updater_unavailable' });
    if (current.busy || current.phase === 'recovery-required')
      return reply.code(409).send({ error: 'management_busy' });
    const id = randomUUID();
    const temporary = path.join(directory, `request-${id}.json`);
    try {
      await atomicJson(temporary, { id, requestedAt: Date.now(), request: input }, 0o660);
      // Hard-link publication is atomic and exclusive: a second request cannot overwrite the first.
      await link(temporary, path.join(directory, 'request.json'));
      return reply.code(202).send({ accepted: true, id });
    } catch (error) {
      return reply.code((error as NodeJS.ErrnoException).code === 'EEXIST' ? 409 : 503).send({
        error: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'management_busy' : 'updater_unavailable',
      });
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
}
