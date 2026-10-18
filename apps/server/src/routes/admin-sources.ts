import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAdmin } from '../auth.js';
import type { ExtensionRuntime } from './extension-packages.js';
import type { OwnerRuntimeRegistry } from '../extensions/owner-runtime-registry.js';

type Kind = 'package' | 'apk' | 'mangayomi';
async function inventory(runtime: ExtensionRuntime) {
  return [
    ...(await runtime.store.list())
      .filter((p) => p.active)
      .map((p) => ({
        kind: 'package',
        id: p.id,
        enabled: p.enabled,
        name: p.active?.manifest.extension.name,
        version: p.active?.manifest.extension.version,
      })),
    ...(['apk', 'mangayomi'] as const).flatMap(
      (kind) =>
        runtime[kind]?.snapshot().packages.map((p) => ({ kind, id: p.pkg, version: p.version, enabled: p.enabled })) ??
        [],
    ),
  ];
}
export async function registerAdminSourceRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  runtimes: OwnerRuntimeRegistry<ExtensionRuntime>,
) {
  const path = '/api/admin/accounts/:userId/sources';
  for (const method of ['GET', 'POST', 'DELETE'] as const)
    app.route<{ Params: { userId: string }; Body: { kind?: Kind; id?: string } }>({
      method,
      url: path,
      bodyLimit: 4096,
      handler: async (request, reply) => {
        const admin = requireAdmin(request);
        reply.header('Cache-Control', 'no-store');
        const target = await pool.query('select user_id from self_host_accounts where user_id = $1 and role = $2', [
          request.params.userId,
          'member',
        ]);
        if (!target.rowCount) return reply.code(404).send({ error: 'account_not_found' });
        const source = await runtimes.acquire(admin.userId);
        try {
          const destination = await runtimes.acquire(request.params.userId);
          try {
            if (method === 'GET')
              return { packages: await inventory(destination.value), available: await inventory(source.value) };
            const { kind, id } = request.body ?? {};
            if (!kind || !['package', 'apk', 'mangayomi'].includes(kind) || typeof id !== 'string' || id.length > 512)
              return reply.code(400).send({ error: 'invalid_source_binding' });
            const runtime = destination.value;
            if (kind === 'package') {
              const current = await runtime.store.read(id);
              if (method === 'DELETE') {
                if (current?.active) await runtime.catalog.installer.remove(id, current.revision);
              } else {
                if (current?.active) return reply.code(409).send({ error: 'source_binding_exists' });
                const approved = await source.value.store.read(id);
                if (!approved?.active) return reply.code(404).send({ error: 'source_binding_missing' });
                const plan = await runtime.catalog.installer.inspect(approved.active.archive, destination.signal);
                if (plan.package.digest !== approved.active.digest || plan.package.manifest.extension.id !== id)
                  throw new Error('package_approval_mismatch');
                await runtime.catalog.installer.install(plan, { digest: approved.active.digest }, destination.signal);
              }
              await runtime.catalog.refresh();
            } else {
              const host = runtime[kind],
                approved = source.value[kind];
              if (!host || !approved) return reply.code(503).send({ error: 'source_runtime_unavailable' });
              if (method === 'DELETE') {
                const snapshot = host.snapshot();
                if (snapshot.packages.some((p) => p.pkg === id)) await host.change(id, snapshot.revision, 'remove');
              } else if (kind === 'apk') await runtime.apk!.provisionFrom(source.value.apk!, id, destination.signal);
              else await runtime.mangayomi!.provisionFrom(source.value.mangayomi!, id, destination.signal);
            }
            return { changed: true, packages: await inventory(runtime) };
          } finally {
            destination.release();
          }
        } finally {
          source.release();
        }
      },
    });
}
