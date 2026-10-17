import { request } from '../ui/store-db';
import { bytes, requireStore } from '../ui/store-model';
import {
  PLATFORM_STORE_LIMITS as limits,
  type Installation,
  type GrantRow,
  type SessionBinding,
  type ConfigRow,
  type ConfigProposal,
  type PayloadRow,
  type RuntimeMarker,
} from './store-model';
import type { PlatformPermission } from '@boaa/extension-contracts/platform-package';
export const getInstallation = (
  tx: IDBTransaction,
  scope: string,
  pluginId: string,
): Promise<Installation | undefined> => request(tx.objectStore('installations').get([scope, pluginId]));
export const getConfig = (tx: IDBTransaction, row: Installation): Promise<ConfigRow | undefined> =>
  request(tx.objectStore('config').get([row.scope, row.installationId]));
export async function authorize(
  tx: IDBTransaction,
  binding: SessionBinding,
  permission?: PlatformPermission,
): Promise<Installation> {
  const f = binding.fence;
  const install = await getInstallation(tx, binding.scope, binding.pluginId);
  requireStore(
    install &&
      install.enabled &&
      !install.tombstone &&
      install.active === f.digest &&
      install.installationId === f.installationId &&
      install.revision === f.generation,
    'PACKAGE_GENERATION_CHANGED',
  );
  const grant: GrantRow | undefined = await request(tx.objectStore('grants').get([binding.scope, binding.pluginId]));
  requireStore(
    install.manifest?.entries[binding.role] &&
      grant &&
      grant.installationId === f.installationId &&
      grant.digest === f.digest &&
      grant.revision === f.generation &&
      grant.roles[binding.role],
    'PERMISSION_DENIED',
  );
  requireStore(
    !permission ||
      (grant.roles[binding.role]!.includes(permission) &&
        install.manifest.entries[binding.role]!.permissions.includes(permission)),
    'PERMISSION_DENIED',
  );
  return install;
}
interface Usage {
  id: 'profile';
  configBytes: number;
  archiveBytes: number;
  installs: number;
}
export async function usage(tx: IDBTransaction): Promise<Usage> {
  return (
    (await request<Usage | undefined>(tx.objectStore('usage').get('profile'))) ?? {
      id: 'profile',
      configBytes: 0,
      archiveBytes: 0,
      installs: 0,
    }
  );
}
const configSize = (c: ConfigRow) => bytes({ schema: c.schema, value: c.value });
export async function putConfig(
  tx: IDBTransaction,
  install: Installation,
  old: ConfigRow | undefined,
  proposal: ConfigProposal,
): Promise<ConfigRow> {
  requireStore(
    (old?.revision ?? 0) === proposal.expectedRevision && proposal.expectedRevision < Number.MAX_SAFE_INTEGER,
    'CONFIG_CONFLICT',
  );
  const row: ConfigRow = {
    scope: install.scope,
    installationId: install.installationId,
    digest: install.active!,
    revision: proposal.expectedRevision + 1,
    schema: proposal.schema,
    value: proposal.value,
  };
  const u = await usage(tx);
  u.configBytes += configSize(row) - (old ? configSize(old) : 0);
  requireStore(u.configBytes <= limits.profileConfigBytes, 'QUOTA_EXCEEDED');
  tx.objectStore('config').put(row);
  tx.objectStore('usage').put(u);
  return row;
}
export async function purgeConfig(tx: IDBTransaction, install: Installation): Promise<void> {
  const old = await getConfig(tx, install);
  if (old) {
    const u = await usage(tx);
    u.configBytes -= configSize(old);
    tx.objectStore('usage').put(u);
    tx.objectStore('config').delete([install.scope, install.installationId]);
  }
}
export async function keepPayloads(
  tx: IDBTransaction,
  scope: string,
  pluginId: string,
  keep: string[],
  added?: PayloadRow,
): Promise<void> {
  const store = tx.objectStore('archives');
  const rows: PayloadRow[] = await request(store.index('owner').getAll([scope, pluginId]));
  const u = await usage(tx);
  for (const row of rows)
    if (!keep.includes(row.digest)) {
      u.archiveBytes -= row.blob instanceof Blob ? row.blob.size : row.blob.byteLength;
      store.delete([scope, pluginId, row.digest]);
    }
  if (added && !rows.some((row) => row.digest === added.digest))
    u.archiveBytes += added.blob instanceof Blob ? added.blob.size : added.blob.byteLength;
  requireStore(u.archiveBytes <= limits.archiveBytes, 'QUOTA_EXCEEDED');
  if (added) store.put(added);
  tx.objectStore('usage').put(u);
}
export async function readMarkers(tx: IDBTransaction, scope: string): Promise<RuntimeMarker[]> {
  return request(tx.objectStore('runtime-markers').index('scope').getAll(scope));
}
