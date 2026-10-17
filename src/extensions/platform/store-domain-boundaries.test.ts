import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PlatformPluginStore } from './plugin-store';
import { UiPluginDatabase } from '../ui/store-db';
import { scope, id, install, schema, setup } from './store-test-fixture';
import type { Retirement, RetirementJournal } from './retirement-journal';
const stores: PlatformPluginStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
it('aborts a delegated config write before transaction commit without exposing its value', async () => {
  const { store, peer } = setup();
  stores.push(store, peer);
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  const before = await store.registerSettings(session, schema);
  const controller = new AbortController();
  const original = UiPluginDatabase.prototype.run;
  vi.spyOn(UiPluginDatabase.prototype, 'run').mockImplementationOnce(function (
    this: UiPluginDatabase,
    mode,
    guard,
    work,
  ) {
    return original.call(this, mode, guard, async (tx) => {
      const result = await work(tx);
      controller.abort();
      return result;
    }) as ReturnType<typeof original>;
  });
  await expect(
    store.writeConfig(
      session,
      { schema, expectedRevision: before.revision, value: { ...before.value, enabled: false } },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await peer.inspectConfig(id, row.revision)).toEqual(before);
});
it('keeps config validation before stale session access', async () => {
  const { store, peer } = setup();
  stores.push(store, peer);
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  store.closeSession(session);
  await expect(store.writeConfig(session, { schema, expectedRevision: -1, value: {} })).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  });
  await expect(
    store.writeConfig(session, { schema, expectedRevision: 0, value: { color: '#123456', enabled: true } }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it('revokes immediately but permits captured post-stop retirement after suspension', async () => {
  const { store, peer } = setup();
  stores.push(store, peer);
  const row = await install(store);
  const session = await store.openSession(id, 'controller', row.revision);
  await store.startMarker(session);
  const finish = store.retireSession(session);
  await expect(store.assertSession(session, session.fence)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  store.suspend();
  await finish();
  expect(await peer.unfinishedMarkers()).toEqual([]);
});
it('does not continue a retirement replay into a replacement authenticated scope', async () => {
  const receipts: Retirement[] = [];
  let changeAfterFirst = false;
  const journal: RetirementJournal = {
    remember: (r) => receipts.push(r),
    pending: () => [...receipts],
    forget: (r) => {
      receipts.splice(receipts.indexOf(r), 1);
      if (changeAfterFirst) {
        changeAfterFirst = false;
        owner.changeScope({ ...scope, accountId: 'replacement' });
      }
    },
  };
  const options = { factory: new IDBFactory(), name: crypto.randomUUID(), retirements: journal };
  const owner = new PlatformPluginStore(scope, options);
  const peer = new PlatformPluginStore(scope, options);
  stores.push(owner, peer);
  const row = await install(owner);
  for (let i = 0; i < 2; i++) {
    const session = await owner.openSession(id, 'controller', row.revision);
    await owner.startMarker(session);
    receipts.push({
      scope: row.scope,
      installationId: session.fence.installationId,
      instanceId: session.fence.instanceId,
      fence: session.fence,
    });
    owner.closeSession(session);
  }
  changeAfterFirst = true;
  await expect(owner.finishRetirements()).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(receipts).toHaveLength(1);
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  owner.changeScope(scope);
  await owner.finishRetirements();
  expect(receipts).toEqual([]);
  expect(await peer.unfinishedMarkers()).toEqual([]);
});
