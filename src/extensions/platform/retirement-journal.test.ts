import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PlatformPluginStore } from './plugin-store';
import { scope, install, id, single } from './store-test-fixture';
import type { Retirement, RetirementJournal } from './retirement-journal';
it('replays only exact stopped instances and retains crashes, other scopes and forged fences', async () => {
  const rows: Retirement[] = [];
  const journal: RetirementJournal = {
    remember: (r) => {
      rows.push(r);
    },
    forget: (r) => {
      rows.splice(rows.indexOf(r), 1);
    },
    pending: () => [...rows],
  };
  const options = { factory: new IDBFactory(), name: crypto.randomUUID(), retirements: journal };
  const old = new PlatformPluginStore(scope, options);
  const row = await install(old),
    stopped = await old.openSession(id, 'controller', row.revision);
  await old.startMarker(stopped);
  const finish = old.retireSession(stopped);
  // Simulate navigation cutting off the asynchronous IDB deletion after host termination.
  await old.close();
  await expect(finish()).rejects.toThrow();
  expect(rows).toHaveLength(1);
  const next = new PlatformPluginStore(scope, options),
    other = new PlatformPluginStore({ ...scope, accountId: 'bob' }, options);
  try {
    await other.finishRetirements();
    expect(rows).toHaveLength(1);
    await next.finishRetirements();
    expect(await next.unfinishedMarkers()).toEqual([]);
    const crashed = await next.openSession(id, 'controller', row.revision);
    await next.startMarker(crashed);
    next.closeSession(crashed);
    rows.push({
      scope: JSON.stringify(['remote', scope.profileId, scope.serverId, scope.accountId, scope.libraryId]),
      installationId: crashed.fence.installationId,
      instanceId: crashed.fence.instanceId,
      fence: { ...crashed.fence, generation: 99 },
    });
    await next.finishRetirements();
    expect(await next.unfinishedMarkers()).toHaveLength(1);
    await next.finishRetirements();
    expect(await next.unfinishedMarkers()).toHaveLength(1);
    next.suspend();
    await expect(next.inspect(single(), 'single-js', 'file')).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  } finally {
    await next.close();
    await other.close();
  }
});
