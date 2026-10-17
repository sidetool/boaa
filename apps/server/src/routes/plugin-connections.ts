import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uiKeys, uiRecord } from '@boaa/extension-contracts/ui-json';
import {
  pluginHttpOwner,
  pluginHttpRequest,
  pluginSlot,
  PLUGIN_HTTP_METHODS,
  type PluginHttpOwner,
} from '../../../../packages/extension-contracts/plugin-http';
import { requestCookie, SELF_HOST_SESSION_COOKIE } from '../auth-cookie';
import type { ServerConfig } from '../config';
import { pluginScope } from '../plugins/plugin-scope.js';
import { loadProviderSecretMasterKey } from '../providers/server-provider-secrets';
import {
  approvePluginEndpoint,
  credentialHeaderAllowed,
  pluginHttpTransport,
  privateOrigins,
} from '../plugins/http-transport';
interface Connection {
  id: string;
  digest: string;
  generation: string;
  slot: string;
  endpoint: string;
  roles: string[];
  methods: string[];
  headers: string[];
  revision: string;
  auth_header: string | null;
  encrypted_secret: string | null;
}
const assert = (v: unknown): void => {
  if (!v) throw Error('PLUGIN_CONNECTION_DENIED');
};
const values = (a: string, o: PluginHttpOwner) => [a, o.profileId, o.installationId, o.digest, o.generation];
const where =
  "account_id=$1 and profile_id=$2 and installation_id=$3 and digest=$4 and generation=$5 and scope_key=(select server_id::text||':'||library_id::text from plugin_deployment_identity where singleton_key=1)";
export function registerPluginConnectionRoutes(app: FastifyInstance, config: ServerConfig, pool: pg.Pool) {
  if (!config.pluginOrigin) return;
  const allowed = privateOrigins(config.pluginPrivateOrigins ?? '[]');
  const pending = new Map<string, AbortController>();
  const seen = new Map<string, number>();
  const identity = async (req: FastifyRequest) => {
    // All endpoints require a same-origin host POST and a real account cookie.
    assert(req.headers.origin === config.pluginOrigin && req.headers['x-boaa-plugin-host'] === '1');
    const token = requestCookie(req, SELF_HOST_SESSION_COOKIE);
    assert(token && token.length <= 512);
    const scope = await pluginScope(pool, token!, config.defaultUserId);
    assert(scope);
    return scope!;
  };
  const seal = (text: string, aad: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', loadProviderSecretMasterKey(config, process.env), iv);
    cipher.setAAD(Buffer.from(aad));
    return [iv, Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]), cipher.getAuthTag()]
      .map((b) => b.toString('base64'))
      .join('.');
  };
  const open = (text: string, aad: string) => {
    const [iv, bytes, tag] = text.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', loadProviderSecretMasterKey(config, process.env), iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
  };
  const prefix = (account: string, owner: PluginHttpOwner) =>
    JSON.stringify([account, owner.profileId, owner.installationId]) + ':';
  const abortConnections = (account: string, owner: PluginHttpOwner) => {
    for (const [key, abort] of pending) if (key.startsWith(prefix(account, owner))) abort.abort();
  };
  app.post('/api/plugins/connections/:action', { bodyLimit: 48 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const scope = await identity(req),
        b = req.body;
      assert(uiRecord(b) && pluginHttpOwner(b.owner));
      const body = b as Record<string, unknown>,
        owner = body.owner as PluginHttpOwner;
      const args = values(scope.accountId, owner);
      const action = (req.params as { action: string }).action;
      if (action === 'list') {
        assert(uiKeys(body, ['owner']));
        const result = await pool.query<Connection>(`select * from plugin_connections where ${where}`, args);
        return result.rows.map((r) => ({
          slot: r.slot,
          endpoint: r.endpoint,
          roles: r.roles,
          methods: r.methods,
          headers: r.headers,
          revision: r.revision,
          authenticated: !!r.encrypted_secret,
        }));
      }
      if (action === 'revoke') {
        assert(uiKeys(body, ['owner'], ['slot']) && (body.slot === undefined || pluginSlot(body.slot)));
        await pool.query(
          `delete from plugin_connections where account_id=$1 and profile_id=$2 and installation_id=$3 ${body.slot === undefined ? '' : 'and slot=$4'}`,
          [...args.slice(0, 3), ...(body.slot === undefined ? [] : [body.slot])],
        );
        abortConnections(scope.accountId, owner);
        return { ok: true };
      }
      if (action === 'approve') {
        assert(uiKeys(body, ['owner', 'slot', 'endpoint', 'roles', 'methods', 'headers', 'auth']));
        assert(pluginSlot(body.slot) && typeof body.endpoint === 'string');
        assert(
          Array.isArray(body.roles) &&
            body.roles.length > 0 &&
            body.roles.length <= 2 &&
            body.roles.every((r) => ['controller', 'ui'].includes(r)),
        );
        assert(
          Array.isArray(body.methods) &&
            body.methods.length > 0 &&
            body.methods.length <= 7 &&
            body.methods.every((m) => PLUGIN_HTTP_METHODS.includes(m)),
        );
        assert(
          Array.isArray(body.headers) &&
            body.headers.length <= 16 &&
            body.headers.every((h) => typeof h === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(h)),
        );
        assert(uiRecord(body.auth) && uiKeys(body.auth, ['kind'], ['header', 'value']));
        const auth = body.auth as Record<string, unknown>;
        assert(['none', 'bearer', 'header'].includes(String(auth.kind)));
        let header: string | null = null,
          secret: string | null = null;
        if (auth.kind !== 'none') {
          assert(
            typeof auth.value === 'string' &&
              auth.value.length > 0 &&
              auth.value.length <= 4096 &&
              !/[\r\n\0]/.test(auth.value),
          );
          header = auth.kind === 'bearer' ? 'authorization' : String(auth.header);
          assert(credentialHeaderAllowed(header));
          secret = auth.kind === 'bearer' ? `Bearer ${auth.value}` : String(auth.value);
        }
        await approvePluginEndpoint(String(body.endpoint), config.pluginOrigin!, allowed, undefined, config.port);
        await identity(req);
        const id = randomUUID(),
          revision = randomUUID();
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('select account_id from plugin_account_identity where account_id=$1 for update', [
            scope.accountId,
          ]);
          const count = await client.query<{ count: string }>(
            'select count(*) from plugin_connections where account_id=$1',
            [scope.accountId],
          );
          const existing = await client.query(
            'select slot from plugin_connections where account_id=$1 and profile_id=$2 and installation_id=$3',
            args.slice(0, 3),
          );
          assert(
            existing.rows.some((r) => r.slot === body.slot) ||
              (Number(count.rows[0].count) < 128 && existing.rows.length < 8),
          );
          await client.query(
            `insert into plugin_connections (id, account_id, profile_id, installation_id, digest, generation, slot, endpoint, roles, methods, auth_header, encrypted_secret, revision, scope_key, headers) values ($6,$1,$2,$3,$4,$5,$7,$8,$9,$10,$11,$12,$13,(select server_id::text||':'||library_id::text from plugin_deployment_identity where singleton_key=1),$14) on conflict(account_id,profile_id,installation_id,slot) do update set id=excluded.id,digest=excluded.digest,generation=excluded.generation,endpoint=excluded.endpoint,roles=excluded.roles,methods=excluded.methods,auth_header=excluded.auth_header,encrypted_secret=excluded.encrypted_secret,revision=excluded.revision,scope_key=excluded.scope_key,headers=excluded.headers`,
            [
              ...args,
              id,
              body.slot,
              body.endpoint,
              JSON.stringify(body.roles),
              JSON.stringify(body.methods),
              header,
              secret === null ? null : seal(secret, `${scope.accountId}:${id}:${revision}`),
              revision,
              JSON.stringify(body.headers),
            ],
          );
          await client.query('commit');
        } catch (e) {
          await client.query('rollback');
          throw e;
        } finally {
          client.release();
        }
        abortConnections(scope.accountId, owner);
        return { ok: true };
      }
      assert(action === 'request' || action === 'cancel');
      assert(typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId));
      const key = prefix(scope.accountId, owner) + body.requestId;
      const now = Date.now();
      for (const [k, deadline] of seen) if (deadline < now) seen.delete(k);
      assert(seen.has(key) || seen.size < 2048);
      if (action === 'cancel') {
        assert(uiKeys(body, ['owner', 'requestId']));
        seen.set(key, now + 60000); // Prevent a reordered request arriving after cancellation.
        pending.get(key)?.abort();
        return { ok: true };
      }
      assert(uiKeys(body, ['owner', 'requestId', 'role', 'revision', 'request']) && pluginHttpRequest(body.request));
      assert(
        !seen.has(key) &&
          pending.size < 16 &&
          [...pending.keys()].filter((k) => k.startsWith(prefix(scope.accountId, owner))).length < 4,
      );
      seen.set(key, now + 60000);
      const input = body.request as Parameters<typeof pluginHttpTransport>[0];
      const load = async () => {
        const current = await identity(req);
        assert(current.accountId === scope.accountId && current.libraryId === scope.libraryId);
        const result = await pool.query<Connection>(
          `select * from plugin_connections where ${where} and slot=$6 and revision=$7`,
          [...args, input.slot, body.revision],
        );
        const row = result.rows[0];
        assert(row && row.roles.includes(String(body.role)) && row.methods.includes(input.method));
        return row;
      };
      const controller = new AbortController();
      pending.set(key, controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      let checking = false;
      const poll = setInterval(() => {
        if (checking) return;
        checking = true;
        void load()
          .catch(() => controller.abort())
          .finally(() => {
            checking = false;
          });
      }, 250);
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on('close', disconnect);
      try {
        const row = await load();
        const credential =
          row.auth_header && row.encrypted_secret
            ? {
                header: row.auth_header,
                value: open(row.encrypted_secret, `${scope.accountId}:${row.id}:${row.revision}`),
              }
            : undefined;
        return await pluginHttpTransport(
          input,
          row.endpoint,
          credential,
          config.pluginOrigin!,
          allowed,
          row.headers,
          config.port,
          controller.signal,
          async () => {
            await load();
          },
        );
      } finally {
        clearTimeout(timeout);
        clearInterval(poll);
        reply.raw.off('close', disconnect);
        pending.delete(key);
      }
    } catch {
      return reply.code(403).send({ error: 'PLUGIN_CONNECTION_DENIED' });
    }
  });
  app.addHook('onClose', async () => {
    for (const controller of pending.values()) controller.abort();
  });
}
