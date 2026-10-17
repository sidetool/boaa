import { afterEach, it, expect } from 'vitest';
import { setup, composite, approve, id, schema } from './store-test-fixture';
import type { PlatformPluginStore } from './plugin-store';
const stores: PlatformPluginStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function fixture(taskApproved = true) {
  const { store, peer } = setup();
  stores.push(store, peer);
  const review = await store.inspect(await composite(), 'package', 'fixture');
  const approval = approve(review);
  if (!taskApproved) delete approval.roles.task;
  const row = await store.install(review, approval);
  const owner = await store.openSession(id, 'controller', row.revision);
  return { store, peer, row, owner };
}
it('creates an independent task session of the exact approved controller generation', async () => {
  const { store, owner } = await fixture();
  const task = await store.openTaskSession(owner);
  expect(task.role).toBe('task');
  expect(task.fence.instanceId).not.toBe(owner.fence.instanceId);
  expect(task.fence.digest).toBe(owner.fence.digest);
  expect(task.fence.generation).toBe(owner.fence.generation);
  expect(await store.sessionPermissions(task)).toEqual([]);
  await store.registerSettings(owner, schema);
  await expect(store.readConfig(task)).rejects.toThrow('PERMISSION_DENIED');
  await expect(store.assertCall(task, task.fence, 'tasks.run')).rejects.toThrow('METHOD_NOT_ALLOWED');
  store.closeSession(task);
  await expect(store.assertSession(owner, owner.fence)).resolves.toBeUndefined();
});
it('requires separate approval of the declared task role', async () => {
  const { store, owner } = await fixture(false);
  await expect(store.openTaskSession(owner)).rejects.toThrow('PERMISSION_DENIED');
});
it('rejects a copied owner and an owner revoked by another tab', async () => {
  const { store, peer, owner, row } = await fixture();
  await expect(store.openTaskSession({ ...owner })).rejects.toThrow('CONTEXT_STALE');
  await peer.disable(id, row.revision);
  await expect(store.openTaskSession(owner)).rejects.toThrow('PACKAGE_GENERATION_CHANGED');
});
