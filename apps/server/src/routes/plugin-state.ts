import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { requireUserId } from '../auth';
import { requestCookie, SELF_HOST_SESSION_COOKIE } from '../auth-cookie';
import type { ServerConfig } from '../config';
import { pluginScope } from '../plugins/plugin-scope';
import { resolvePluginRequestOrigin } from '../plugins/plugin-origin';
import { uiRecord, uiKeys, uiInteger } from '@boaa/extension-contracts/ui-json';
import { PLUGIN_STATE_LIMITS, type PluginStateChange } from '../../../../packages/extension-contracts/plugin-state';
import { scopeKey } from '../../../../src/extensions/ui/store-model';
import {
  preparePluginStateChanges,
  validatePluginStateGraph,
  pluginStateRowId,
  type StoredPluginRow,
} from '../plugins/plugin-state-validation';

export function registerPluginStateRoutes(app: FastifyInstance, config: ServerConfig, pool: pg.Pool) {
  const identity = async (req: FastifyRequest) => {
    resolvePluginRequestOrigin(req, config);
    if (req.headers['x-boaa-plugin-host'] !== '1') throw Error('PLUGIN_STATE_DENIED');
    const token = requestCookie(req, SELF_HOST_SESSION_COOKIE);
    if (!token || token.length > 512) throw Error('PLUGIN_STATE_DENIED');
    const scope = await pluginScope(pool, token, requireUserId(req));
    if (!scope) throw Error('PLUGIN_STATE_DENIED');
    return { ...scope, scope: scopeKey({ kind: 'remote', profileId: scope.accountId, ...scope }) };
  };
  app.get('/api/plugins/state', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
    try {
      const owner = await identity(req);
      const query = req.query as Record<string, unknown>,
        since = Number(query.since ?? 0);
      if (!uiInteger(since, 0, Number.MAX_SAFE_INTEGER)) return reply.code(400).send({ error: 'PLUGIN_STATE_INVALID' });
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const version = await client.query<{ revision: string; floor_revision: string }>(
          'select revision,floor_revision from plugin_state_versions where account_id=$1 and library_id=$2',
          [owner.accountId, owner.libraryId],
        );
        const revision = Number(version.rows[0]?.revision ?? 0);
        const reset = since > revision || since < Number(version.rows[0]?.floor_revision ?? 0);
        const rows = await client.query<{
          store: PluginStateChange['store'];
          key: string;
          value: Record<string, unknown> | null;
        }>(
          `select store,row_key as key,value from plugin_state_rows where account_id=$1 and library_id=$2 and ${reset ? 'value is not null' : 'revision>$3'} order by store,row_key`,
          reset ? [owner.accountId, owner.libraryId] : [owner.accountId, owner.libraryId, since],
        );
        await client.query('commit');
        return {
          revision,
          ...(reset ? { reset: true } : {}),
          changes: rows.rows.map((r) => ({
            store: r.store,
            key: JSON.parse(r.key),
            ...(r.value === null ? {} : { value: r.value }),
          })),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } catch {
      return reply.code(403).send({ error: 'PLUGIN_STATE_DENIED' });
    }
  });
  app.post('/api/plugins/state', { bodyLimit: PLUGIN_STATE_LIMITS.patchBytes }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const owner = await identity(req),
        body = req.body;
      if (
        !uiRecord(body) ||
        !uiKeys(body, ['expectedRevision', 'changes']) ||
        !uiInteger(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)
      )
        return reply.code(400).send({ error: 'PLUGIN_STATE_INVALID' });
      const prepared = await preparePluginStateChanges(body.changes, owner.scope),
        changes = body.changes as unknown as PluginStateChange[];
      // Archive verification may take time. Recheck the live cookie before acquiring write authority.
      if ((await identity(req)).accountId !== owner.accountId) throw Error('PLUGIN_STATE_DENIED');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          'insert into plugin_state_versions(account_id,library_id,revision) values($1,$2,0) on conflict do nothing',
          [owner.accountId, owner.libraryId],
        );
        const version = await client.query<{ revision: string }>(
          'select revision from plugin_state_versions where account_id=$1 and library_id=$2 for update',
          [owner.accountId, owner.libraryId],
        );
        if (Number(version.rows[0].revision) !== body.expectedRevision) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'STATE_CONFLICT' });
        }
        const old = await client.query<StoredPluginRow>(
          `select store,row_key as key,case when store='archives' then value-'blobBase64' else value end as value,metadata from plugin_state_rows where account_id=$1 and library_id=$2 and value is not null`,
          [owner.accountId, owner.libraryId],
        );
        const next = new Map(old.rows.map((r) => [pluginStateRowId(r.store, JSON.parse(r.key)), r]));
        for (let i = 0; i < prepared.length; i++) {
          const row = prepared[i],
            key = pluginStateRowId(row.store, JSON.parse(row.key));
          if (changes[i].value === undefined) next.delete(key);
          else next.set(key, row);
        }
        validatePluginStateGraph([...next.values()], old.rows, changes);
        const revision = body.expectedRevision + 1;
        for (let i = 0; i < prepared.length; i++) {
          const row = prepared[i];
          if (changes[i].value === undefined && !old.rows.some((r) => r.store === row.store && r.key === row.key))
            continue;
          await client.query(
            `insert into plugin_state_rows(account_id,library_id,store,row_key,value,metadata,revision) values($1,$2,$3,$4,$5,$6,$7) on conflict(account_id,library_id,store,row_key) do update set value=excluded.value,metadata=excluded.metadata,revision=excluded.revision`,
            [
              owner.accountId,
              owner.libraryId,
              row.store,
              row.key,
              changes[i].value === undefined ? null : JSON.stringify(row.value),
              JSON.stringify(row.metadata ?? null),
              revision,
            ],
          );
        }
        for (const change of changes.filter((c) => c.store === 'installations')) {
          const oldInstall = old.rows.find(
            (r) => r.store === 'installations' && r.key === JSON.stringify(change.key),
          )?.value;
          if (!oldInstall) continue;
          const install = change.value!;
          // Retire only after the state CAS succeeds, within its transaction. Other accounts are never affected.
          await client.query(
            `delete from plugin_connections where account_id=$1 and installation_id=$2 and (installation_id<>$3 or digest<>$4 or generation<>$5 or $6)`,
            [
              owner.accountId,
              oldInstall.installationId,
              install.installationId,
              install.active ?? '',
              install.revision,
              !install.enabled,
            ],
          );
        }
        await client.query('update plugin_state_versions set revision=$3 where account_id=$1 and library_id=$2', [
          owner.accountId,
          owner.libraryId,
          revision,
        ]);
        const tombstones = await client.query<{ count: string }>(
          'select count(*) as count from plugin_state_rows where account_id=$1 and library_id=$2 and value is null',
          [owner.accountId, owner.libraryId],
        );
        if (Number(tombstones.rows[0].count) > 2048) {
          await client.query('delete from plugin_state_rows where account_id=$1 and library_id=$2 and value is null', [
            owner.accountId,
            owner.libraryId,
          ]);
          await client.query(
            'update plugin_state_versions set floor_revision=$3 where account_id=$1 and library_id=$2',
            [owner.accountId, owner.libraryId, revision],
          );
        }
        await client.query('commit');
        return { revision };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return reply
        .code(
          code === 'PLUGIN_STATE_QUOTA'
            ? 413
            : code === 'PLUGIN_STATE_DENIED' || code === 'PLUGIN_ORIGIN_DENIED'
              ? 403
              : 400,
        )
        .send({ error: code === 'PLUGIN_STATE_QUOTA' ? 'PLUGIN_STATE_QUOTA' : 'PLUGIN_STATE_INVALID' });
    }
  });
}
