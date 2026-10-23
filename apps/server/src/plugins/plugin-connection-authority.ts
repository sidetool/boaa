import type pg from 'pg';
import type { PluginHttpOwner } from '../../../../packages/extension-contracts/plugin-http';
import type { Installation, GrantRow } from '../../../../src/extensions/platform/store-model';

/** Stored connection consent cannot outlive the account's active installation or role grants. */
export async function requirePluginConnectionAuthority(
  db: Pick<pg.Pool, 'query'>,
  scope: { accountId: string; libraryId: string },
  owner: PluginHttpOwner,
  slot: string,
  roles: readonly string[],
) {
  if (owner.profileId !== scope.accountId || !roles.length) throw Error('PLUGIN_CONNECTION_DENIED');
  const result = await db.query<{ installation: Installation; grants: GrantRow }>(
    `select i.value as installation,g.value as grants from plugin_state_rows i
     join plugin_state_rows g on g.account_id=i.account_id and g.library_id=i.library_id
       and g.row_key=i.row_key and g.store='grants'
     where i.account_id=$1 and i.library_id=$2 and i.store='installations'
       and i.value->>'installationId'=$3`,
    [scope.accountId, scope.libraryId, owner.installationId],
  );
  const row = result.rows[0],
    install = row?.installation,
    grants = row?.grants;
  if (
    !install?.enabled ||
    install.tombstone ||
    install.active !== owner.digest ||
    install.revision !== owner.generation ||
    grants?.installationId !== owner.installationId ||
    grants.digest !== owner.digest ||
    grants.revision !== owner.generation ||
    !install.manifest?.contributes.connections?.includes(slot) ||
    !roles.every(
      (role) =>
        (role === 'controller' || role === 'ui') &&
        install.manifest?.entries[role]?.permissions.includes('http.request') &&
        grants.roles[role]?.includes('http.request'),
    )
  )
    throw Error('PLUGIN_CONNECTION_DENIED');
}
