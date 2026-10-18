import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { IndexedDbPackageInstallStore } from '../../../../src/extensions/packages/package-install-store.js';
import { buildBoaaExtension } from '../../../../src/extensions/packages/package-builder.js';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture.js';
import { createNodePackageExecution } from '../extensions/node-package-execution.js';
import { OwnerRuntimeRegistry } from '../extensions/owner-runtime-registry.js';
import { createExtensionRuntime, registerExtensionPackageRoutes } from './extension-packages.js';
import { registerAdminSourceRoutes } from './admin-sources.js';

const code = `globalThis.boaaExtension=async method=>method==='describe'?{apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]}:{items:[]};`;
describe('administrator source provisioning', () => {
  it('installs verified code into empty A/B bindings without admin settings and fences member mutations', async () => {
    const stores = new Map<string, IndexedDbPackageInstallStore>();
    const runtimes = new OwnerRuntimeRegistry(async (owner) => {
      let store = stores.get(owner);
      if (!store) {
        store = new IndexedDbPackageInstallStore('owner-' + crypto.randomUUID());
        stores.set(owner, store);
      }
      return createExtensionRuntime(store, createNodePackageExecution());
    });
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const owner = String(request.headers['x-test-owner'] ?? 'admin');
      request.principal = { userId: owner, role: owner === 'admin' ? 'admin' : 'member', authMethod: 'legacy-token' };
    });
    const admin = await runtimes.acquire('admin');
    const archive = await buildBoaaExtension({ manifest: examplePackageManifest(), source: code, license: 'test' });
    const plan = await admin.value.catalog.installer.inspect(archive);
    await admin.value.catalog.installer.install(plan, { digest: plan.package.digest });
    const record = (await admin.value.store.read('org.example.catalog'))!;
    await admin.value.store.compareAndSwap(record.id, record.revision, {
      ...record,
      revision: record.revision + 1,
      active: { ...record.active!, settings: { privateToken: 'admin-only' } },
    });
    const pool = {
      query: async (_sql: string, params: string[]) => ({ rowCount: ['a', 'b'].includes(params[0]) ? 1 : 0 }),
    } as unknown as pg.Pool;
    await registerAdminSourceRoutes(app, pool, runtimes);
    await registerExtensionPackageRoutes(
      app,
      admin.value.store,
      createNodePackageExecution(),
      undefined,
      undefined,
      new Set(),
      async () => {
        throw new Error('unused');
      },
      {
        read: async () => ({}),
        stage: async () => {
          throw new Error('unused');
        },
      },
      async (request) => {
        const lease = await runtimes.acquire(request.principal!.userId);
        lease.release();
        return lease.value;
      },
    );
    try {
      const route = '/api/admin/accounts/a/sources';
      for (const url of [
        '/api/extensions/sources/org.example.catalog.source/content-connection',
        '/api/extensions/packages/%69nstall',
        '/api/extensions/packages/%69nspect',
        '/api/extensions/packages/org.example.catalog/%75pdate',
        '/api/extensions/%72epositories/refresh',
        '/api/extensions/packages/org.example.catalog/%63hange',
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: { 'x-test-owner': 'a' },
              payload: { action: 'remove', revision: 1 },
            })
          ).statusCode,
        ).toBe(403);
      }

      expect(
        (
          await app.inject({
            method: 'POST',
            url: route,
            headers: { 'x-test-owner': 'a' },
            payload: { kind: 'package', id: record.id },
          })
        ).statusCode,
      ).toBe(403);
      for (const owner of ['a', 'b']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/admin/accounts/${owner}/sources`,
              payload: { kind: 'package', id: record.id },
            })
          ).statusCode,
        ).toBe(200);
        const saved = await stores.get(owner)!.read(record.id);
        expect(saved!.active!.settings).toEqual({});
        expect(saved!.credentialEpoch).not.toBe(record.credentialEpoch);
      }
      expect(
        (await app.inject({ method: 'POST', url: route, payload: { kind: 'package', id: record.id } })).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/extensions/packages/${record.id}/change`,
            headers: { 'x-test-owner': 'a' },
            payload: { action: 'remove', revision: 1 },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/extensions/packages/${record.id}/change`,
            headers: { 'x-test-owner': 'a' },
            payload: { action: 'disable', revision: 1 },
          })
        ).statusCode,
      ).toBe(200);
      expect((await stores.get('b')!.read(record.id))!.enabled).toBe(true);
      await runtimes.dispose('a');
      const reopened = await runtimes.acquire('a');
      expect((await reopened.value.store.read(record.id))!.enabled).toBe(false);
      reopened.release();
      expect(
        (await app.inject({ method: 'DELETE', url: route, payload: { kind: 'package', id: record.id } })).statusCode,
      ).toBe(200);
      expect((await stores.get('b')!.read(record.id))!.active).toBeDefined();
    } finally {
      admin.release();
      await app.close();
      await runtimes.close();
      for (const store of stores.values()) await store.close();
    }
  });
});
