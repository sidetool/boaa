import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Authenticate the cookie and resolve its account incarnation in one SQL statement.
 * A deployment bearer token is intentionally insufficient for plugin approval scope. */
export async function pluginScope(pool: pg.Pool, token: string, userId: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  // Normal identity checks are read-only. Only the first authenticated request initializes IDs.
  const current = await pool.query<{ serverId: string; accountId: string; libraryId: string }>(
    `
    select d.server_id as "serverId", i.account_id as "accountId", d.library_id as "libraryId"
    from self_host_sessions s join self_host_accounts a on a.user_id=s.user_id
    left join plugin_account_identity i on i.user_id=a.user_id
    left join plugin_deployment_identity d on d.singleton_key=1
    where s.token_hash=$1 and s.expires_at>now() and a.user_id=$2 and a.status='active' and a.auth_version=s.auth_version`,
    [tokenHash, userId],
  );
  const existing = current.rows[0];
  if (!existing) return undefined;
  if (existing.serverId && existing.accountId && existing.libraryId) return existing;
  await pool.query(`insert into plugin_deployment_identity values (1, $1, $2) on conflict do nothing`, [
    randomUUID(),
    randomUUID(),
  ]);
  const result = await pool.query<{ serverId: string; libraryId: string; accountId: string }>(
    `
    with account as (
      select a.user_id from self_host_sessions s join self_host_accounts a on a.user_id=s.user_id
      where s.token_hash=$1 and s.expires_at>now() and a.user_id=$2 and a.status='active' and a.auth_version=s.auth_version
    ), identity as (
      insert into plugin_account_identity(user_id, account_id)
      select user_id, $3::uuid from account
      on conflict(user_id) do update set user_id=excluded.user_id
      returning account_id
    )
    select d.server_id as "serverId", d.library_id as "libraryId", i.account_id as "accountId"
    from plugin_deployment_identity d cross join identity i where d.singleton_key=1`,
    [tokenHash, userId, randomUUID()],
  );
  return result.rows[0];
}

/** Stable identity is independent of whether the plugin runtime is enabled. */
export async function accountIdentity(pool: pg.Pool, userId: string) {
  await pool.query(`insert into plugin_deployment_identity values(1,$1,$2) on conflict do nothing`, [
    randomUUID(),
    randomUUID(),
  ]);
  await pool.query(
    `insert into plugin_account_identity(user_id,account_id) select user_id,$2::uuid from self_host_accounts where user_id=$1 on conflict do nothing`,
    [userId, randomUUID()],
  );
  const result = await pool.query<{ serverId: string; libraryId: string; accountId: string }>(
    `select d.server_id as "serverId",d.library_id as "libraryId",i.account_id as "accountId" from plugin_deployment_identity d join plugin_account_identity i on i.user_id=$1 where d.singleton_key=1`,
    [userId],
  );
  if (!result.rows[0]) throw new Error('account_identity_unavailable');
  return result.rows[0];
}
