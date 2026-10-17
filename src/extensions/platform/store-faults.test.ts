import { afterEach, expect, it, vi } from 'vitest';
import { setup, install, id, schema, single, approve, scope } from './store-test-fixture';
import { PlatformPluginStore } from './plugin-store';
import * as verification from '../packages/platform-package';
import { request, UiPluginDatabase } from '../ui/store-db';
import { platformLayout, PLATFORM_STORE_LIMITS } from './store-model';
const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function fixture() {
  const f = setup();
  stores.push(f.store, f.peer);
  const db = new UiPluginDatabase(f.factory, `boaa.js-plugins.v1:${f.name}`, platformLayout);
  stores.push(db);
  const row = await install(f.store);
  const session = await f.store.openSession(id, 'controller', row.revision);
  return { ...f, db, row, session };
}
it('re-verifies persisted source bytes before delivery', async () => {
  const { store, db, row, session } = await fixture();
  await db.run(
    'readwrite',
    () => {},
    async (tx) => {
      const payload = await request(tx.objectStore('archives').get([row.scope, id, row.active!]));
      tx.objectStore('archives').put({ ...payload, blob: single('1.0.0', '//tampered') });
    },
  );
  await expect(store.loadEntry(session)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
});
it('discards code verified while another tab revokes authority', async () => {
  const { store, peer, row, session } = await fixture();
  const original = verification.verifyPlatformSingleJs;
  let started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.spyOn(verification, 'verifyPlatformSingleJs').mockImplementationOnce(async (...args) => {
    started();
    await gate;
    return original(...args);
  });
  const pending = store.loadEntry(session);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
  await entered;
  await peer.disable(id, row.revision);
  release();
  await rejected;
});
it('aborts a config commit if the scope changes during its transaction', async () => {
  const { store, peer, row, session } = await fixture();
  const saved = await store.registerSettings(session, schema);
  const run = UiPluginDatabase.prototype.run;
  vi.spyOn(UiPluginDatabase.prototype, 'run').mockImplementationOnce(function (
    this: UiPluginDatabase,
    mode,
    guard,
    work,
  ) {
    return run.call(this, mode, guard, async (tx) => {
      const result = await work(tx);
      store.changeScope({ ...scope, accountId: 'other' });
      return result;
    }) as ReturnType<typeof run>;
  });
  await expect(
    store.writeConfig(session, { schema, expectedRevision: 1, value: { color: '#abcdef', enabled: false } }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(await peer.inspectConfig(id, row.revision)).toEqual(saved);
});
it('rolls back both configuration and package changes on quota failure', async () => {
  const { store, db, row, session } = await fixture();
  const saved = await store.registerSettings(session, schema);
  const review = await store.inspect(single('2.0.0'), 'single-js', 'file:plugin');
  await db.run(
    'readwrite',
    () => {},
    async (tx) => {
      const u = await request(tx.objectStore('usage').get('profile'));
      tx.objectStore('usage').put({ ...u, archiveBytes: PLATFORM_STORE_LIMITS.archiveBytes });
    },
  );
  await expect(
    store.install(
      review,
      approve(review, {
        data: 'preserve',
        allowUnsignedDataReuse: true,
        config: { expectedRevision: 1, schema: { ...schema, version: 2 }, value: saved.value },
      }),
    ),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect((await store.list())[0]).toEqual(row);
  expect(await store.readConfig(session)).toEqual(saved);
});
it('reopens durable configuration and markers with fresh session authority', async () => {
  const { store, factory, name, row, session } = await fixture();
  await store.registerSettings(session, schema);
  await store.startMarker(session);
  await store.close();
  const reopened = new PlatformPluginStore(scope, { factory, name });
  stores.push(reopened);
  const fresh = await reopened.openSession(id, 'controller', row.revision);
  expect((await reopened.readConfig(fresh))?.value.color).toBe('#123456');
  expect(await reopened.unfinishedMarkers()).toHaveLength(1);
  await expect(reopened.readConfig(session)).rejects.toThrow('CONTEXT_STALE');
});
it('aborts a settings write cancelled before transaction completion', async () => {
  const { store, peer, row, session } = await fixture();
  const saved = await store.registerSettings(session, schema);
  const controller = new AbortController();
  const run = UiPluginDatabase.prototype.run;
  vi.spyOn(UiPluginDatabase.prototype, 'run').mockImplementationOnce(function (
    this: UiPluginDatabase,
    mode,
    guard,
    work,
  ) {
    return run.call(this, mode, guard, async (tx) => {
      const result = await work(tx);
      controller.abort();
      return result;
    }) as ReturnType<typeof run>;
  });
  await expect(
    store.writeConfig(
      session,
      { schema, expectedRevision: 1, value: { color: '#abcdef', enabled: false } },
      controller.signal,
    ),
  ).rejects.toThrow('CANCELLED');
  expect(await peer.inspectConfig(id, row.revision)).toEqual(saved);
});
it('stores exact byte payloads and still reads and removes legacy Blob archives', async () => {
  const { store, db, row, session } = await fixture();
  await db.run(
    'readwrite',
    () => {},
    async (tx) => {
      const payload = await request(tx.objectStore('archives').get([row.scope, id, row.active!]));
      expect(payload.blob).toBeInstanceOf(ArrayBuffer);
      // Simulate a pre-G3 installation, without changing the approved digest or bytes.
      tx.objectStore('archives').put({ ...payload, blob: new Blob([payload.blob]) });
    },
  );
  expect(await store.loadEntry(session)).toBe(await single().text());
  expect((await store.inspectRetained(id, 'active')).digest).toBe(row.active);
  await store.disable(id, row.revision, true);
  await db.run(
    'readonly',
    () => {},
    async (tx) => {
      expect(await request(tx.objectStore('archives').count())).toBe(0);
      const usage = await request(tx.objectStore('usage').getAll());
      expect(usage[0].archiveBytes).toBe(0);
    },
  );
});
