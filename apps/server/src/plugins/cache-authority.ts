import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { PluginHttpOwner } from '../../../../packages/extension-contracts/plugin-http';
import type { Installation, GrantRow } from '../../../../src/extensions/platform/store-model';

export async function cacheAuthority(
  db: Pick<pg.Pool, 'query'>,
  scope: { accountId: string; libraryId: string },
  owner: PluginHttpOwner,
  access?: { kind: 'home' | 'data'; role: 'controller' | 'ui'; key: string },
) {
  const rows = await db.query<{ installation: Installation; grants: GrantRow }>(
    `select i.value installation,g.value grants from plugin_state_rows i
    join plugin_state_rows g on g.account_id=i.account_id and g.library_id=i.library_id and g.row_key=i.row_key and g.store='grants'
    where i.account_id=$1 and i.library_id=$2 and i.store='installations' and i.value->>'installationId'=$3`,
    [scope.accountId, scope.libraryId, owner.installationId],
  );
  const { installation: i, grants: g } = rows.rows[0] ?? {};
  if (
    owner.profileId !== scope.accountId ||
    !i?.enabled ||
    i.tombstone ||
    i.active !== owner.digest ||
    i.revision !== owner.generation ||
    g?.installationId !== owner.installationId ||
    g.digest !== owner.digest ||
    g.revision !== owner.generation
  )
    throw Error('CACHE_DENIED');
  if (access) {
    const permission = access.kind === 'home' ? 'home.feed' : 'storage.own';
    if (
      !i.manifest?.entries[access.role]?.permissions.includes(permission) ||
      !g.roles[access.role]?.includes(permission) ||
      (access.kind === 'home' &&
        (access.role !== 'controller' || !i.manifest.contributes.homeSections?.some((s) => s.id === access.key))) ||
      (access.kind === 'data' &&
        ![...(i.manifest.features.required ?? []), ...(i.manifest.features.optional ?? [])].includes('cache.own'))
    )
      throw Error('CACHE_DENIED');
  }
  const connections = await db.query(
    `select slot,revision,endpoint,roles,methods,headers from plugin_connections
    where account_id=$1 and profile_id=$1 and installation_id=$2 and digest=$3 and generation=$4
      and scope_key=(select server_id::text||':'||library_id::text from plugin_deployment_identity where singleton_key=1) order by slot`,
    [scope.accountId, owner.installationId, owner.digest, owner.generation],
  );
  return createHash('sha256')
    .update(JSON.stringify([owner.digest, owner.generation, g.roles, connections.rows]))
    .digest('hex');
}
