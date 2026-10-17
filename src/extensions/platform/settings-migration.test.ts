import { afterEach, expect, it, vi } from 'vitest';
import { setup, single, approve, id, schema, scope } from './store-test-fixture';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function fixture() {
  let now = 0;
  const { store, peer } = setup(() => now);
  closes.push(
    () => store.close(),
    () => peer.close(),
  );
  const first = await store.inspect(single(), 'single-js', 'fixture');
  const installed = await store.install(
    first,
    approve(first, { config: { expectedRevision: 0, schema, value: { color: '#123456', enabled: true } } }),
  );
  await store.disable(id, installed.revision);
  const review = await store.inspect(single('2.0.0'), 'single-js', 'fixture');
  const approval = approve(review, { data: 'preserve', allowUnsignedDataReuse: true });
  const before = (await store.list())[0];
  const config = await store.inspectConfig(id, before.revision);
  const result = { schema: { ...schema, version: 2 }, value: { color: '#abcdef', enabled: false } };
  const signal = new AbortController();
  return {
    store,
    peer,
    review,
    approval,
    before,
    config,
    result,
    signal,
    expire: () => {
      now = 400000;
    },
  };
}
it('commits only the approved source result with package, schema and configuration in one generation', async () => {
  const f = await fixture();
  const runner = vi.fn(async (request) => {
    expect(request.source).toContain('Never run in storage');
    expect(request.input).toEqual({ fromVersion: 1, value: f.config!.value });
    expect(request.fence.digest).toBe(f.review.digest);
    expect((await f.store.list())[0]).toEqual(f.before);
    return f.result;
  });
  const row = await f.store.installWithMigration(f.review, f.approval, runner, f.signal.signal);
  expect(row.active).toBe(f.review.digest);
  expect(row.previous).toBe(f.before.active);
  expect(row.installationId).toBe(f.before.installationId);
  expect(await f.store.inspectConfig(id, row.revision)).toMatchObject({ ...f.result, digest: row.active, revision: 2 });
  expect(runner).toHaveBeenCalledOnce();
});
it.each(['failure', 'invalid', 'cancel', 'expired'] as const)(
  'preserves the old package/config after %s and consumes the execution attempt',
  async (mode) => {
    const f = await fixture();
    const runner = vi.fn(async () => {
      if (mode === 'failure') throw Error('GUEST_FAILURE');
      if (mode === 'cancel') f.signal.abort();
      if (mode === 'expired') f.expire();
      return mode === 'invalid' ? { ...f.result, value: { color: 3 } } : f.result;
    });
    await expect(f.store.installWithMigration(f.review, f.approval, runner, f.signal.signal)).rejects.toThrow();
    expect((await f.store.list())[0]).toEqual(f.before);
    expect(await f.store.inspectConfig(id, f.before.revision)).toEqual(f.config);
    await expect(
      f.store.installWithMigration(f.review, f.approval, runner, new AbortController().signal),
    ).rejects.toThrow();
    expect(runner).toHaveBeenCalledOnce();
  },
);
it.each(['permission', 'provenance', 'forged', 'enabled', 'marker'] as const)(
  'rejects %s before executing new code',
  async (mode) => {
    const f = await fixture();
    const runner = vi.fn(async () => f.result);
    if (mode === 'permission') f.approval.roles.controller = [];
    if (mode === 'provenance') delete f.approval.allowUnsignedDataReuse;
    if (mode === 'forged') f.review = { ...f.review };
    if (mode === 'enabled' || mode === 'marker') {
      const old = await f.store.inspectRetained(id, 'active');
      const row = await f.store.install(old, approve(old, { data: 'preserve', allowUnsignedDataReuse: true }));
      if (mode === 'marker') {
        const session = await f.store.openSession(id, 'controller', row.revision);
        await f.store.startMarker(session);
        await f.store.disable(id, row.revision);
      }
      f.review = await f.store.inspect(single('2.0.0'), 'single-js', 'fixture');
    }
    await expect(f.store.installWithMigration(f.review, f.approval, runner, f.signal.signal)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  },
);
it('rejects concurrent replacement and scope changes after guest computation', async () => {
  for (const change of ['replace', 'scope']) {
    const f = await fixture();
    await expect(
      f.store.installWithMigration(
        f.review,
        f.approval,
        async () => {
          if (change === 'replace') await f.peer.disable(id, f.before.revision);
          else f.store.changeScope({ ...scope, accountId: 'other' });
          return f.result;
        },
        f.signal.signal,
      ),
    ).rejects.toThrow();
    const row = (await f.peer.list())[0];
    expect(row.active).toBe(f.before.active);
    expect(await f.peer.inspectConfig(id, row.revision)).toEqual(f.config);
  }
});
it('rolls back both records when archive persistence fails after writing the converted config', async () => {
  const { IDBObjectStore } = await import('fake-indexeddb');
  const f = await fixture();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<typeof put>
  ) {
    if (this.name === 'archives') throw new DOMException('full', 'QuotaExceededError');
    return put.apply(this, args);
  });
  try {
    await expect(
      f.store.installWithMigration(f.review, f.approval, async () => f.result, f.signal.signal),
    ).rejects.toThrow('QUOTA_EXCEEDED');
  } finally {
    spy.mockRestore();
  }
  expect((await f.store.list())[0]).toEqual(f.before);
  expect(await f.store.inspectConfig(id, f.before.revision)).toEqual(f.config);
});
