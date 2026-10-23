import { expect, it } from 'vitest';
import { ServerPluginDatabase } from './server-plugin-database';
import { PlatformPluginStore } from './plugin-store';
import { scope, single, approve, id, schema } from './store-test-fixture';
import { scopeKey } from '../ui/store-model';
import { request } from '../ui/store-db';
import {
  preparePluginStateChanges,
  validatePluginStateGraph,
  pluginStateRowId,
  type StoredPluginRow,
} from '../../../apps/server/src/plugins/plugin-state-validation';
import type { PluginStateChange } from '../../../packages/extension-contracts/plugin-state';
import type { GrantRow } from './store-model';

function backend() {
  let revision = 0,
    writes = 0;
  const state = new Map<string, StoredPluginRow>(),
    history: { revision: number; changes: PluginStateChange[] }[] = [];
  const transport: typeof fetch = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      if (body.expectedRevision !== revision) return Response.json({}, { status: 409 });
      const changes = body.changes as PluginStateChange[];
      const rows = await preparePluginStateChanges(changes, scopeKey(scope));
      const next = new Map(state);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i],
          key = pluginStateRowId(row.store, JSON.parse(row.key));
        if (changes[i].value) next.set(key, row);
        else next.delete(key);
      }
      validatePluginStateGraph([...next.values()], [...state.values()], changes);
      state.clear();
      for (const [key, row] of next) state.set(key, row);
      writes++;
      revision++;
      history.push({ revision, changes });
      return Response.json({ revision });
    }
    const since = Number(new URL(String(url), 'https://example.test').searchParams.get('since'));
    return Response.json({
      revision,
      changes: history.filter((entry) => entry.revision > since).flatMap((entry) => entry.changes),
    });
  };
  return {
    transport,
    state,
    get writes() {
      return writes;
    },
  };
}
async function kvSource(version = '1.0.0') {
  const header = {
    id,
    version,
    apiVersion: 2,
    license: 'MIT',
    activation: ['onAppSession'],
    permissions: ['settings.own', 'storage.own'],
    features: ['settings.schema', 'storage.own'],
    contributes: {},
    storageKiB: 2,
  };
  return new Blob([`/* @boaa-plugin ${JSON.stringify(header)} */\nthrow Error('must not execute');`]);
}
async function settingsRegistrationRace() {
  const server = backend();
  let release!: () => void,
    entered!: () => void,
    attempts = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const a = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport }),
    b = new ServerPluginDatabase({
      scope: scopeKey(scope),
      transport: async (url, init) => {
        if (init?.method === 'POST') {
          attempts++;
          entered();
          await gate;
        }
        return server.transport(url, init);
      },
    });
  const first = new PlatformPluginStore(scope, { database: a }),
    second = new PlatformPluginStore(scope, { database: b });
  const review = await first.inspect(single(), 'single-js', 'local-file');
  const row = await first.install(review, approve(review));
  await b.refresh();
  const one = await first.openSession(id, 'controller', row.revision),
    two = await second.openSession(id, 'controller', row.revision);
  const pending = second.registerSettings(two, schema);
  await dispatched;
  return {
    server,
    a,
    first,
    second,
    row,
    one,
    pending,
    release,
    get attempts() {
      return attempts;
    },
    async close() {
      release();
      await pending.catch(() => {});
      await Promise.all([first.close(), second.close()]);
    },
  };
}
it('reuses the winning settings registration and later user edits after a cross-browser initialization race', async () => {
  const race = await settingsRegistrationRace();
  try {
    const defaults = await race.first.registerSettings(race.one, schema);
    const saved = await race.first.writeConfig(race.one, {
      schema,
      expectedRevision: defaults.revision,
      value: { color: '#abcdef', enabled: false },
    });
    const writes = race.server.writes;
    race.release();
    await expect(race.pending).resolves.toEqual(saved);
    expect(race.attempts).toBe(1);
    expect(race.server.writes).toBe(writes);
    expect(await race.first.readConfig(race.one)).toEqual(saved);
  } finally {
    await race.close();
  }
});
it.each([
  ['changed schema', 'CONFIG_MIGRATION_REQUIRED'],
  ['disabled installation', 'PACKAGE_GENERATION_CHANGED'],
  ['revoked permission', 'PERMISSION_DENIED'],
  ['unrelated change without settings', 'STATE_CONFLICT'],
])('does not recover settings registration from %s or replay the rejected write', async (change, code) => {
  const race = await settingsRegistrationRace();
  try {
    if (change === 'changed schema') await race.first.registerSettings(race.one, { ...schema, version: 2 });
    else if (change === 'unrelated change without settings') await race.a.writePreference('reader-input', null);
    else {
      await race.first.registerSettings(race.one, schema);
      if (change === 'disabled installation') await race.first.disable(id, race.row.revision);
      else
        await race.a.run(
          'readwrite',
          () => {},
          async (tx) => {
            const grants = tx.objectStore('grants');
            const grant = await request<GrantRow>(grants.get([scopeKey(scope), id]));
            grants.put({ ...grant, roles: { ...grant.roles, controller: [] } });
          },
        );
    }
    const writes = race.server.writes;
    race.release();
    await expect(race.pending).rejects.toMatchObject({ code });
    expect(race.attempts).toBe(1);
    expect(race.server.writes).toBe(writes);
  } finally {
    await race.close();
  }
});
it('persists installations, settings and KV across independent browsers; markers stay window-local', async () => {
  const server = backend(),
    a = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport }),
    b = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport });
  const first = new PlatformPluginStore(scope, { database: a });
  const review = await first.inspect(await kvSource(), 'single-js', 'local-file');
  const installed = await first.install(review, approve(review));
  const session = await first.openSession(id, 'controller', installed.revision);
  await first.registerSettings(session, schema);
  await first.storageSet(session, { key: 'rankings', value: ['one', 'two'], expectedRevision: null });
  const writes = server.writes;
  await first.startMarker(session);
  expect(server.writes).toBe(writes);
  const second = new PlatformPluginStore(scope, { database: b });
  expect((await second.list())[0].active).toBe(installed.active);
  const other = await second.openSession(id, 'controller', installed.revision);
  expect(await second.readConfig(other)).toMatchObject({ value: { color: '#123456', enabled: true } });
  expect(await second.storageGet(other, { key: 'rankings' })).toMatchObject({ found: true, value: ['one', 'two'] });
  expect(await second.unfinishedMarkers()).toEqual([]);
  expect([...server.state.values()].some((row) => String(row.store) === 'runtime-markers')).toBe(false);
  await first.close();
  await second.close();
});
it('rejects a stale-browser write, refreshes without replay, and keeps the committed value', async () => {
  const server = backend(),
    a = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport }),
    b = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport });
  const first = new PlatformPluginStore(scope, { database: a }),
    second = new PlatformPluginStore(scope, { database: b });
  const review = await first.inspect(await kvSource(), 'single-js', 'local-file');
  const row = await first.install(review, approve(review));
  await b.refresh();
  const one = await first.openSession(id, 'controller', row.revision),
    two = await second.openSession(id, 'controller', row.revision);
  await first.storageSet(one, { key: 'rankings', value: 'winner', expectedRevision: null });
  await expect(
    second.storageSet(two, { key: 'rankings', value: 'loser', expectedRevision: null }),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  expect(await second.storageGet(two, { key: 'rankings' })).toMatchObject({ found: true, value: 'winner' });
  expect(server.writes).toBe(2);
  await first.close();
  await second.close();
});
it('does not commit failed transactions and supports account preferences without IndexedDB', async () => {
  const server = backend(),
    db = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport });
  await db.refresh();
  await expect(
    db.run(
      'readwrite',
      () => {},
      async (tx) => {
        tx.objectStore('preferences').put({ scope: scopeKey(scope), key: 'reader-input', value: null });
        throw Error('failed');
      },
    ),
  ).rejects.toThrow('failed');
  expect(server.writes).toBe(0);
  expect(await db.readPreference('reader-input')).toBeUndefined();
  await db.writePreference('reader-input', null);
  expect(server.writes).toBe(1);
  expect(await db.readPreference('reader-input')).toBeNull();
  await db.close();
});
it('does not report success or expose a write until the server acknowledges it', async () => {
  const server = backend();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === 'POST') {
      entered();
      await gate;
    }
    return server.transport(url, init);
  };
  const db = new ServerPluginDatabase({ scope: scopeKey(scope), transport });
  let finished = false;
  const writing = db.writePreference('reader-input', null).then(() => {
    finished = true;
  });
  await dispatched;
  expect(finished).toBe(false);
  expect(server.writes).toBe(0);
  expect(db.getRevision()).toBe(0);
  release();
  await writing;
  expect(finished).toBe(true);
  expect(db.getRevision()).toBe(1);
  await db.close();
});
it('rejects foreign scopes and tampered package digests before accepting state', async () => {
  const server = backend(),
    db = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport }),
    store = new PlatformPluginStore(scope, { database: db });
  const review = await store.inspect(single(), 'single-js', 'local-file');
  await store.install(review, approve(review));
  const archive = [...server.state.values()].find((row) => row.store === 'archives')!;
  await expect(
    preparePluginStateChanges(
      [
        {
          store: 'archives',
          key: JSON.parse(archive.key),
          value: { ...archive.value, blobBase64: Buffer.from('tampered').toString('base64') },
        },
      ],
      scopeKey(scope),
    ),
  ).rejects.toThrow();
  await expect(
    preparePluginStateChanges(
      [
        {
          store: 'preferences',
          key: ['other', 'reader-input'],
          value: { scope: 'other', key: 'reader-input', value: null },
        },
      ],
      scopeKey(scope),
    ),
  ).rejects.toThrow();
  expect(
    await db.run(
      'readonly',
      () => {},
      async (tx) => request(tx.objectStore('archives').count()),
    ),
  ).toBe(1);
  await store.close();
});
it('enforces server-side grants, storage quotas and the durable-store allowlist independently of the browser', async () => {
  const server = backend(),
    db = new ServerPluginDatabase({ scope: scopeKey(scope), transport: server.transport }),
    store = new PlatformPluginStore(scope, { database: db });
  const review = await store.inspect(await kvSource(), 'single-js', 'local-file');
  const install = await store.install(review, approve(review));
  const previous = [...server.state.values()],
    grant = previous.find((row) => row.store === 'grants')!;
  expect(() =>
    validatePluginStateGraph(
      previous.map((row) =>
        row === grant ? { ...row, value: { ...row.value, roles: { controller: ['http.request'] } } } : row,
      ),
      previous,
      [],
    ),
  ).toThrow('PLUGIN_STATE_INVALID');
  const kv = {
    scope: scopeKey(scope),
    installationId: install.installationId,
    key: 'large',
    value: 'x'.repeat(3000),
    revision: 1,
  };
  expect(() =>
    validatePluginStateGraph(
      [
        ...previous,
        { store: 'kv', key: JSON.stringify([scopeKey(scope), install.installationId, 'large']), value: kv },
      ],
      previous,
      [],
    ),
  ).toThrow('PLUGIN_STATE_QUOTA');
  await expect(
    preparePluginStateChanges(
      [{ store: 'runtime-markers', key: ['scope', 'id', 'window'], value: {} }],
      scopeKey(scope),
    ),
  ).rejects.toThrow('PLUGIN_STATE_INVALID');
  await store.close();
});
it('replaces stale memory after server history resets and keeps only window-local runtime markers', async () => {
  let reset = false;
  const db = new ServerPluginDatabase({
    scope: scopeKey(scope),
    transport: async () =>
      Response.json(
        reset
          ? { revision: 0, reset: true, changes: [] }
          : {
              revision: 1,
              changes: [
                {
                  store: 'preferences',
                  key: [scopeKey(scope), 'reader-input'],
                  value: { scope: scopeKey(scope), key: 'reader-input', value: null },
                },
              ],
            },
      ),
  });
  await db.refresh();
  await db.run(
    'readwrite',
    () => {},
    async (tx) => {
      tx.objectStore('runtime-markers').put({ scope: scopeKey(scope), installationId: 'local', instanceId: 'window' });
    },
  );
  expect(await db.readPreference('reader-input')).toBeNull();
  reset = true;
  await db.refresh();
  expect(await db.readPreference('reader-input')).toBeUndefined();
  expect(
    await db.run(
      'readonly',
      () => {},
      async (tx) => request(tx.objectStore('runtime-markers').count()),
    ),
  ).toBe(1);
  await db.close();
});
