import { afterEach, expect, it } from 'vitest';
import { UiPluginStore } from './plugin-store';
import { scope, id, approve, preserve, setup, install, packageFixture, permissionList } from './store-test-fixture';
const stores: UiPluginStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
function fixture() {
  const f = setup();
  stores.push(f.store, f.peer);
  return f;
}
const sign = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
it('inspects without execution or writes; binds approval to the exact review, digest, permissions and revision', async () => {
  const { store } = fixture();
  const review = await store.inspect(await packageFixture(), 'file:a');
  expect(await store.list()).toEqual([]);
  await expect(store.install(structuredClone(review), approve(review))).rejects.toMatchObject({
    code: 'REVIEW_EXPIRED',
  });
  await expect(store.install(review, approve(review, { digest: 'wrong' }))).rejects.toMatchObject({
    code: 'APPROVAL_MISMATCH',
  });
  await expect(
    store.install(review, approve(review, { permissions: ['network.fetch'] as never })),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  Object.assign(review.manifest.extension, { id: 'org.evil.other' });
  const result = await store.install(review, approve(review));
  expect(result.pluginId).toBe(id);
  expect(result.revision).toBe(1);
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
});
it('serializes competing installs and rejects a pending update after removal', async () => {
  const { store, peer } = fixture();
  const blob = await packageFixture();
  const a = await store.inspect(blob, 'file:a');
  const b = await peer.inspect(blob, 'file:a');
  const results = await Promise.allSettled([store.install(a, approve(a)), peer.install(b, approve(b))]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'INSTALL_CONFLICT' } });
  const stale = await store.inspect(await packageFixture('1.1.0'), 'file:a');
  await peer.remove(id, 1);
  await expect(store.install(stale, approve(stale, preserve))).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' });
  expect((await store.list())[0]).toMatchObject({ revision: 2, tombstone: true });
});
it('preserves data only through explicit review and invalidates old sessions on update/revoke/rollback', async () => {
  const { store, peer } = fixture();
  const first = await install(store);
  const session = await store.openSession(id);
  await store.storage(session, 'storage.set', {
    key: 'word',
    value: 'saved',
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  const review = await store.inspect(await packageFixture('2.0.0'), 'local-file:fixture');
  await expect(store.install(review, approve(review, { data: 'preserve' }))).rejects.toMatchObject({
    code: 'DATA_REUSE_REQUIRES_REVIEW',
  });
  const next = await store.install(review, approve(review, preserve));
  expect(next.installationId).toBe(first.installationId);
  await expect(store.storage(session, 'storage.get', { key: 'word' })).rejects.toMatchObject({
    code: 'PACKAGE_GENERATION_CHANGED',
  });
  const current = await store.openSession(id);
  expect(await store.storage(current, 'storage.get', { key: 'word' })).toMatchObject({ found: true, value: 'saved' });
  await peer.revoke(id, 2);
  await expect(store.assertSession(current)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
  const rollback = await store.inspectRollback(id);
  await expect(store.install(rollback, approve(rollback, preserve))).rejects.toMatchObject({
    code: 'DOWNGRADE_REVIEW_REQUIRED',
  });
  const restored = await store.install(
    rollback,
    approve(rollback, { ...preserve, enabled: false, permissions: [], allowDowngrade: true }),
  );
  expect(restored.manifest?.extension.version).toBe('1.0.0');
  await expect(store.openSession(id)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
});
it('isolates publisher changes and unsigned provenance changes; reinstall never inherits a removed namespace', async () => {
  const { store } = fixture();
  const first = await install(store);
  const session = await store.openSession(id);
  await store.storage(session, 'storage.set', {
    key: 'secret',
    value: 'old',
    expectedRevision: null,
    idempotencyKey: 'a',
  });
  const changedSource = await store.inspect(await packageFixture('2.0.0'), 'file:other');
  expect(changedSource.sourceChanged).toBe(true);
  await expect(store.install(changedSource, approve(changedSource, preserve))).rejects.toMatchObject({
    code: 'DATA_REUSE_REQUIRES_REVIEW',
  });
  const publisher = await store.inspect(await packageFixture('2.0.0', { key: await sign() }), 'file:signed');
  await expect(store.install(publisher, approve(publisher))).rejects.toMatchObject({
    code: 'PUBLISHER_REVIEW_REQUIRED',
  });
  await expect(
    store.install(publisher, approve(publisher, { ...preserve, allowPublisherChange: true })),
  ).rejects.toMatchObject({ code: 'DATA_REUSE_REQUIRES_REVIEW' });
  const signed = await store.install(publisher, approve(publisher, { allowPublisherChange: true }));
  expect(signed.installationId).not.toBe(first.installationId);
  expect(await store.storage(await store.openSession(id), 'storage.get', { key: 'secret' })).toEqual({ found: false });
  await store.remove(id, signed.revision);
  const reinstalled = await install(store);
  expect(reinstalled.installationId).not.toBe(signed.installationId);
});
it('same signer updates retain data, but same version different bytes needs its own review', async () => {
  const { store } = fixture();
  const key = await sign();
  const first = await install(store, await packageFixture('1.0.0', { key }));
  const review = await store.inspect(await packageFixture('1.0.0', { key, code: '/* alternate */' }), 'file:publisher');
  expect(review.sameVersionReplacement).toBe(true);
  await expect(store.install(review, approve(review, { data: 'preserve' }))).rejects.toMatchObject({
    code: 'VERSION_REVIEW_REQUIRED',
  });
  const next = await store.install(review, approve(review, { data: 'preserve', allowSameVersionReplacement: true }));
  expect(next.installationId).toBe(first.installationId);
});
it('scope switch and logout invalidate review/session handles; forged session IDs never authorize access', async () => {
  const { store } = fixture();
  await install(store);
  const session = await store.openSession(id);
  await expect(store.storage({ ...session }, 'storage.get', { key: 'k' })).rejects.toMatchObject({
    code: 'CONTEXT_STALE',
  });
  const review = await store.inspect(await packageFixture('2.0.0'), 'local-file:fixture');
  store.changeScope({
    kind: 'remote',
    profileId: 'profile',
    serverId: 'server',
    accountId: 'other',
    libraryId: 'library',
  });
  expect(await store.list()).toEqual([]);
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
  await expect(store.storage(session, 'storage.get', { key: 'k' })).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await install(store);
  store.changeScope(scope);
  expect((await store.list())[0].revision).toBe(1);
  await expect(store.assertSession(session)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it('expires reviews and does not implicitly restore previously revoked storage permission', async () => {
  const { store, advance } = fixture();
  const review = await store.inspect(await packageFixture(), 'file:a');
  advance(300001);
  await expect(store.install(review, approve(review))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
  const fresh = await store.inspect(await packageFixture(), 'file:a');
  await store.install(fresh, approve(fresh, { permissions: permissionList.filter((p) => p !== 'storage.own') }));
  const session = await store.openSession(id);
  await expect(store.storage(session, 'storage.get', { key: 'k' })).rejects.toMatchObject({
    code: 'PERMISSION_DENIED',
  });
});
it('persists unfinished markers across reconnect, respects owner, and requires disable before acknowledgement', async () => {
  const { store, peer } = fixture();
  await install(store);
  const session = await store.openSession(id);
  const other = await peer.openSession(id);
  await store.startMarker(session, 'tab-a', 'instance-a');
  await peer.finishMarker(other, 'instance-a');
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  await expect(peer.acknowledgeMarkers(id, 1)).rejects.toMatchObject({ code: 'INSTALL_CONFLICT' });
  await store.close();
  expect(await peer.unfinishedMarkers()).toHaveLength(1);
  await peer.revoke(id, 1);
  await peer.acknowledgeMarkers(id, 2);
  expect(await peer.unfinishedMarkers()).toHaveLength(0);
});

it('re-reviews the retained signed archive to re-enable without restoring old grants automatically', async () => {
  const { store } = fixture();
  await install(store, await packageFixture('1.0.0', { key: await sign() }));
  await store.revoke(id, 1);
  const review = await store.inspectInstalled(id);
  expect(review.sameVersionReplacement).toBe(false);
  await store.install(review, approve(review, { data: 'preserve', permissions: ['ui.panel.render'] }));
  await expect(store.storage(await store.openSession(id), 'storage.get', { key: 'old' })).rejects.toMatchObject({
    code: 'PERMISSION_DENIED',
  });
});

it('retained archive review uses the most recently approved provenance for identical unsigned bytes', async () => {
  const { store } = fixture();
  const archive = await packageFixture();
  await install(store, archive, 'file:first');
  const moved = await store.inspect(archive, 'file:second');
  await store.install(moved, approve(moved));
  await store.revoke(id, 2);
  const retained = await store.inspectInstalled(id);
  expect(retained.provenance).toBe('file:second');
  expect(retained.sourceChanged).toBe(false);
  await store.install(retained, approve(retained, preserve));
});
