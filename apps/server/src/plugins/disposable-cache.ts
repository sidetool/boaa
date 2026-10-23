import type pg from 'pg';
import type { UiJson } from '../../../../packages/extension-contracts/ui-json';
import {
  PLUGIN_CACHE_LIMITS as limits,
  type PluginCacheRequest,
  type PluginCacheResult,
} from '../../../../packages/extension-contracts/plugin-cache';

export interface CacheOwner {
  accountId: string;
  libraryId: string;
  installationId: string;
}
/** Serialize quota accounting across devices, independently of permanent plugin-state writes. */
export async function disposableCache(
  pool: pg.Pool,
  owner: CacheOwner,
  kind: 'home' | 'data' | 'image',
  input: PluginCacheRequest,
  authorize: (db: Pick<pg.Pool, 'query'>) => Promise<string>,
): Promise<PluginCacheResult> {
  const client = await pool.connect();
  const args = [owner.accountId, owner.libraryId, owner.installationId];
  const image = kind === 'image';
  const category = image ? "kind='image'" : "kind<>'image'";
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['plugin-cache:' + owner.accountId]);
    const authority = await authorize(client);
    const now = Date.now();
    await client.query(
      'delete from plugin_cache_entries where account_id=$1 and (expires_at<=$4 or (library_id=$2 and installation_id=$3 and authority<>$5))',
      [...args, now, authority],
    );
    if (input.action === 'remove') {
      await client.query(
        'delete from plugin_cache_entries where account_id=$1 and library_id=$2 and installation_id=$3 and kind=$4 and cache_key=$5',
        [...args, kind, input.key],
      );
    } else if (input.action === 'set') {
      const value = JSON.stringify(input.value);
      const bytes = Buffer.byteLength(value, 'utf8') + Buffer.byteLength(input.key, 'utf8');
      if (bytes > (image ? 710000 : limits.entryBytes)) throw Error('CACHE_LIMIT');
      const fresh = now + input.ttlSeconds! * 1000;
      await client.query(
        `insert into plugin_cache_entries(account_id,library_id,installation_id,authority,kind,cache_key,value,bytes,saved_at,fresh_until,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(account_id,library_id,installation_id,kind,cache_key)
        do update set authority=excluded.authority,value=excluded.value,bytes=excluded.bytes,saved_at=excluded.saved_at,fresh_until=excluded.fresh_until,expires_at=excluded.expires_at`,
        [...args, authority, kind, input.key, value, bytes, now, fresh, fresh + input.staleSeconds! * 1000],
      );
      // Newest saved entries win; no timestamps or eviction targets are guest-controlled.
      await client.query(
        `delete from plugin_cache_entries where ctid in (
        select tid from (select ctid tid, sum(bytes) over(order by saved_at desc,kind,cache_key) total,
        row_number() over(order by saved_at desc,kind,cache_key) count from plugin_cache_entries
        where account_id=$1 and library_id=$2 and installation_id=$3 and ${category}) ranked where total>$4 or count>$5)`,
        [
          ...args,
          image ? limits.imagePluginBytes : limits.pluginBytes,
          image ? limits.imagePluginEntries : limits.pluginEntries,
        ],
      );
      await client.query(
        `delete from plugin_cache_entries where ctid in (
        select tid from (select ctid tid,sum(bytes) over(order by saved_at desc,installation_id,kind,cache_key) total
        from plugin_cache_entries where account_id=$1 and ${category}) ranked where total>$2)`,
        [owner.accountId, image ? limits.imageAccountBytes : limits.accountBytes],
      );
    }
    const result =
      input.action === 'get'
        ? await client.query<{ value: UiJson; saved_at: string; fresh_until: string; expires_at: string }>(
            'select value,saved_at,fresh_until,expires_at from plugin_cache_entries where account_id=$1 and library_id=$2 and installation_id=$3 and kind=$4 and cache_key=$5 and authority=$6 and expires_at>$7',
            [...args, kind, input.key, authority, now],
          )
        : { rows: [] };
    if ((await authorize(client)) !== authority) throw Error('CACHE_AUTHORITY_CHANGED');
    await client.query('commit');
    const row = result.rows[0];
    return row
      ? {
          found: true,
          value: row.value,
          savedAt: Number(row.saved_at),
          freshUntil: Number(row.fresh_until),
          expiresAt: Number(row.expires_at),
        }
      : { found: false };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
