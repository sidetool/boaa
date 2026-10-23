import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { migrateLegacyPlatformPlugins } from './legacy-platform-migration';
import { PlatformPluginStore } from './plugin-store';
import { ServerPluginDatabase } from './server-plugin-database';
import { scope, id, approve, schema } from './store-test-fixture';
import { scopeKey, UiStoreError } from '../ui/store-model';
import {
  preparePluginStateChanges,
  validatePluginStateGraph,
  pluginStateRowId,
  type StoredPluginRow,
} from '../../../apps/server/src/plugins/plugin-state-validation';
import type { PluginStateChange } from '../../../packages/extension-contracts/plugin-state';
const current = { ...scope, profileId: scope.accountId };
function server() {
  let revision = 0;
  const state = new Map<string, StoredPluginRow>();
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.expectedRevision !== revision) return Response.json({}, { status: 409 });
      const changes = body.changes as PluginStateChange[],
        rows = await preparePluginStateChanges(changes, scopeKey(current)),
        next = new Map(state);
      rows.forEach((row, i) => {
        const key = pluginStateRowId(row.store, JSON.parse(row.key));
        if (changes[i].value) next.set(key, row);
        else next.delete(key);
      });
      validatePluginStateGraph([...next.values()], [...state.values()], changes);
      state.clear();
      next.forEach((row, key) => state.set(key, row));
      return Response.json({ revision: ++revision });
    }
    return Response.json({
      revision,
      reset: true,
      changes: [...state.values()].map((row) => ({ store: row.store, key: JSON.parse(row.key), value: row.value })),
    });
  };
  return new ServerPluginDatabase({ scope: scopeKey(current), transport });
}
async function fixture() {
  const factory = new IDBFactory(),
    profile = crypto.randomUUID(),
    oldScope = { ...scope, profileId: profile };
  const legacy = new PlatformPluginStore(oldScope, { factory, name: 'legacy' });
  const source = new Blob([
    `/* @boaa-plugin ${JSON.stringify({ id, version: '1.0.0', apiVersion: 2, license: 'MIT', activation: ['onAppSession'], permissions: ['settings.own', 'storage.own'], features: ['settings.schema', 'storage.own'], contributes: {}, storageKiB: 2 })} */throw Error('must not execute');`,
  ]);
  const review = await legacy.inspect(source, 'single-js', 'local-file'),
    row = await legacy.install(review, approve(review));
  const session = await legacy.openSession(id, 'controller', row.revision);
  await legacy.registerSettings(session, schema);
  await legacy.storageSet(session, { key: 'cache', value: 'saved', expectedRevision: null });
  const again = await legacy.inspectRetained(id, 'active');
  const upgraded = await legacy.install(again, approve(again, { data: 'preserve', allowUnsignedDataReuse: true }));
  const storage = { getItem: (key: string) => (key === 'boaa.plugin-profile.v1' ? profile : null) };
  const database = server();
  const options = { database, newScope: current, storage, factory, databaseNames: ['boaa.js-plugins.v1:legacy'] };
  return { factory, legacy, oldScope, source, database, options, upgraded };
}
it('imports only the current authenticated legacy scope without changing the old database and runs once per plugin', async () => {
  const f = await fixture();
  const imported = await migrateLegacyPlatformPlugins(f.options);
  expect(imported).toEqual({ imported: 1, skipped: 0, failed: 0, rollbackRetainedLocally: 0 });
  const canonical = new PlatformPluginStore(current, { database: f.database });
  const row = (await canonical.list())[0];
  expect(row.revision).toBe(1);
  expect(row.enabled).toBe(true);
  const session = await canonical.openSession(id, 'controller', row.revision);
  expect(await canonical.readConfig(session)).toMatchObject({ value: { color: '#123456', enabled: true } });
  expect(await canonical.storageGet(session, { key: 'cache' })).toMatchObject({ found: true, value: 'saved' });
  expect((await f.legacy.list())[0]).toEqual(f.upgraded);
  expect(await migrateLegacyPlatformPlugins(f.options)).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
  await canonical.disable(id, row.revision, true);
  expect(await migrateLegacyPlatformPlugins(f.options)).toMatchObject({ imported: 0, skipped: 1 });
  expect((await canonical.list())[0].tombstone).toBe(true);
  await canonical.close();
  await f.legacy.close();
});
it('never imports another account scope and never overwrites an existing canonical install', async () => {
  const f = await fixture();
  expect(
    await migrateLegacyPlatformPlugins({ ...f.options, newScope: { ...current, accountId: 'another' } }),
  ).toMatchObject({ imported: 0, failed: 0 });
  const canonical = new PlatformPluginStore(current, { database: f.database });
  const review = await canonical.inspect(f.source, 'single-js', 'local-file');
  const installed = await canonical.install(review, approve(review, { enabled: false }));
  expect(await migrateLegacyPlatformPlugins(f.options)).toMatchObject({ imported: 0, skipped: 1 });
  expect((await canonical.list())[0]).toEqual(installed);
  await canonical.close();
  await f.legacy.close();
});
it('aborts migration on a concurrent canonical writer and leaves all original records intact', async () => {
  const f = await fixture(),
    old = f.database.run.bind(f.database);
  let conflict = true;
  f.database.run = (mode, guard, work) => {
    if (mode === 'readwrite' && conflict) {
      conflict = false;
      return Promise.reject(new UiStoreError('STATE_CONFLICT'));
    }
    return old(mode, guard, work);
  };
  await expect(migrateLegacyPlatformPlugins(f.options)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  expect((await f.legacy.list())[0]).toEqual(f.upgraded);
  await f.database.close();
  await f.legacy.close();
});
it('creates no IndexedDB database when a browser has no legacy profile or database', async () => {
  const factory = new IDBFactory(),
    database = server();
  const options = {
    database,
    newScope: current,
    factory,
    databaseNames: ['missing-legacy'],
    storage: { getItem: () => null as string | null },
  };
  expect(await migrateLegacyPlatformPlugins(options)).toMatchObject({ imported: 0, failed: 0 });
  expect(await factory.databases()).toEqual([]);
  const profile = crypto.randomUUID();
  expect(await migrateLegacyPlatformPlugins({ ...options, storage: { getItem: () => profile } })).toMatchObject({
    imported: 0,
    failed: 0,
  });
  expect(await factory.databases()).toEqual([]);
  await database.close();
});
