import type { VerifiedBrowserUiPackage } from '../packages/browser-ui-package';
import type { UiPermission } from '@boaa/extension-contracts/ui-package';
import { request } from './store-db';
import {
  UI_STORE_LIMITS,
  requireStore,
  namespaceUsage,
  profileUsage,
  type Installation,
  type GrantRow,
  type ProfileUsage,
  type NamespaceUsage,
  type ArchiveRow,
  type InstallApproval,
  type SessionBinding,
  type RuntimeMarker,
} from './store-model';
export async function readInstallation(
  tx: IDBTransaction,
  scope: string,
  id: string,
): Promise<Installation | undefined> {
  return request(tx.objectStore('installations').get([scope, id]));
}
export async function authorize(
  tx: IDBTransaction,
  binding: SessionBinding,
  permission: UiPermission = 'ui.panel.render',
): Promise<Installation> {
  const install = await readInstallation(tx, binding.scope, binding.pluginId);
  const grant: GrantRow | undefined = await request(tx.objectStore('grants').get([binding.scope, binding.pluginId]));
  requireStore(
    install &&
      !install.tombstone &&
      install.enabled &&
      install.installationId === binding.installationId &&
      install.active === binding.digest &&
      install.revision === binding.revision,
    'PACKAGE_GENERATION_CHANGED',
  );
  requireStore(
    grant &&
      grant.installationId === binding.installationId &&
      grant.digest === binding.digest &&
      grant.revision === binding.revision &&
      grant.permissions.includes(permission),
    'PERMISSION_DENIED',
  );
  return install;
}
async function purgeNamespace(tx: IDBTransaction, install: Installation, profile: ProfileUsage) {
  const usage: NamespaceUsage | undefined = await request(tx.objectStore('usage').get(install.installationId));
  profile.dataBytes -= usage?.bytes ?? 0;
  for (const name of ['kv', 'receipts']) {
    const store = tx.objectStore(name);
    const keys = await request(store.index('namespace').getAllKeys([install.scope, install.installationId]));
    for (const key of keys) store.delete(key);
  }
  const markers: RuntimeMarker[] = await request(
    tx.objectStore('runtime-markers').index('scope').getAll(install.scope),
  );
  for (const marker of markers)
    if (marker.installationId === install.installationId)
      tx.objectStore('runtime-markers').delete([marker.scope, marker.installationId, marker.instanceId]);
  tx.objectStore('usage').delete(install.installationId);
}
async function trimArchives(tx: IDBTransaction, scope: string, id: string, keep: string[], profile: ProfileUsage) {
  const store = tx.objectStore('archives');
  const rows: ArchiveRow[] = await request(store.index('owner').getAll([scope, id]));
  for (const row of rows)
    if (!keep.includes(row.digest)) {
      profile.archiveBytes -= row.archive.size;
      store.delete([scope, id, row.digest]);
    }
}
export async function commitInstallation(
  tx: IDBTransaction,
  scope: string,
  pkg: VerifiedBrowserUiPackage,
  expectedRevision: number,
  provenance: string,
  approval: InstallApproval,
  newId: string,
): Promise<Installation> {
  const id = pkg.manifest.extension.id;
  const old = await readInstallation(tx, scope, id);
  requireStore((old?.revision ?? 0) === expectedRevision, 'INSTALL_CONFLICT');
  requireStore(expectedRevision < Number.MAX_SAFE_INTEGER, 'INSTALL_CONFLICT');
  const preserve = approval.data === 'preserve';
  requireStore(
    !preserve ||
      (old &&
        !old.tombstone &&
        old.active &&
        old.publisher === pkg.publisherFingerprint &&
        (pkg.publisherFingerprint || (old.provenance === provenance && approval.allowUnsignedDataReuse))),
    'DATA_REUSE_REQUIRES_REVIEW',
  );
  const profile: ProfileUsage = (await request(tx.objectStore('usage').get('profile'))) ?? profileUsage();
  if (!old) profile.installations++;
  requireStore(profile.installations <= UI_STORE_LIMITS.installations, 'QUOTA_EXCEEDED');
  const installationId = preserve ? old!.installationId : newId;
  if (!preserve && old) await purgeNamespace(tx, old, profile);
  const usage: NamespaceUsage =
    (await request(tx.objectStore('usage').get(installationId))) ?? namespaceUsage(installationId);
  requireStore(
    !approval.permissions.includes('storage.own') || usage.bytes <= pkg.manifest.requestedAccess.storageKiB * 1024,
    'QUOTA_EXCEEDED',
  );
  const previous = old?.active === pkg.digest ? old.previous : old?.active;
  await trimArchives(tx, scope, id, [pkg.digest, ...(previous ? [previous] : [])], profile);
  const archiveKey = [scope, id, pkg.digest];
  if (!(await request(tx.objectStore('archives').getKey(archiveKey)))) {
    profile.archiveBytes += pkg.archive.size;
  }
  tx.objectStore('archives').put({
    scope,
    pluginId: id,
    digest: pkg.digest,
    archive: pkg.archive,
    provenance,
  } satisfies ArchiveRow);
  requireStore(profile.archiveBytes <= UI_STORE_LIMITS.archiveBytes, 'QUOTA_EXCEEDED');
  const installed: Installation = {
    scope,
    pluginId: id,
    revision: expectedRevision + 1,
    installationId,
    enabled: approval.enabled,
    tombstone: false,
    active: pkg.digest,
    previous,
    publisher: pkg.publisherFingerprint,
    provenance,
    manifest: pkg.manifest,
  };
  tx.objectStore('installations').put(installed);
  tx.objectStore('grants').put({
    scope,
    pluginId: id,
    installationId,
    digest: pkg.digest,
    revision: installed.revision,
    permissions: approval.permissions,
  } satisfies GrantRow);
  tx.objectStore('usage').put(usage);
  tx.objectStore('usage').put(profile);
  return installed;
}
export async function changeInstallation(
  tx: IDBTransaction,
  scope: string,
  id: string,
  revision: number,
  remove: boolean,
): Promise<void> {
  const old = await readInstallation(tx, scope, id);
  requireStore(
    old && old.revision === revision && !old.tombstone && revision < Number.MAX_SAFE_INTEGER,
    'INSTALL_CONFLICT',
  );
  const next: Installation = { ...old, enabled: false, revision: revision + 1 };
  if (remove) {
    const profile: ProfileUsage = (await request(tx.objectStore('usage').get('profile'))) ?? profileUsage();
    await purgeNamespace(tx, old, profile);
    await trimArchives(tx, scope, id, [], profile);
    tx.objectStore('usage').put(profile);
    next.tombstone = true;
    delete next.active;
    delete next.previous;
    delete next.manifest;
    delete next.publisher;
  }
  tx.objectStore('installations').put(next);
  tx.objectStore('grants').delete([scope, id]);
}
