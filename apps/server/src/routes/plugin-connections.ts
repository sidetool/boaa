import { pluginImageRequest } from '../../../../packages/extension-contracts/plugin-images';
import { pluginTarget } from '../../../../packages/extension-contracts/plugin-http';
import { pluginImageThumbnail } from '../plugins/image-thumbnail';
import { requireUserId } from '../auth.js';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { disposableCache } from '../plugins/disposable-cache';
import { cacheAuthority } from '../plugins/cache-authority';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
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
import { pluginCoverTransport } from '../plugins/cover-transport.js';
import { resolvePluginRequestOrigin } from '../plugins/plugin-origin.js';
import { requirePluginConnectionAuthority } from '../plugins/plugin-connection-authority.js';
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
export function registerPluginConnectionRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  pool: pg.Pool,
  resolveDefaultProxy: () => string | undefined = () => undefined,
) {
  const allowed = privateOrigins(config.pluginPrivateOrigins ?? '[]');
  const pending = new Map<string, { controller: AbortController; owner: PluginHttpOwner }>();
  const seen = new Map<string, number>();
  const identity = async (req: FastifyRequest, db: Pick<pg.Pool, 'query'> = pool) => {
    // All endpoints require a same-origin host POST and a real account cookie.
    const origin = resolvePluginRequestOrigin(req, config);
    assert(req.headers.origin === origin && req.headers['x-boaa-plugin-host'] === '1');
    const token = requestCookie(req, SELF_HOST_SESSION_COOKIE);
    assert(token && token.length <= 512);
    const scope = await pluginScope(db, token!, requireUserId(req));
    assert(scope);
    return { ...scope!, origin };
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
  const abortConnections = (account: string, owner: PluginHttpOwner, exact = false) => {
    for (const [key, request] of pending)
      if (
        key.startsWith(prefix(account, owner)) &&
        (!exact || (request.owner.digest === owner.digest && request.owner.generation === owner.generation))
      )
        request.controller.abort();
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
          `delete from plugin_connections where ${where} ${body.slot === undefined ? '' : 'and slot=$6'}`,
          [...args, ...(body.slot === undefined ? [] : [body.slot])],
        );
        abortConnections(scope.accountId, owner, true);
        return { ok: true };
      }
      if (action === 'retire') {
        assert(uiKeys(body, ['owner']));
        await pool.query(`delete from plugin_connections where ${where}`, args);
        abortConnections(scope.accountId, owner, true);
        return { ok: true };
      }
      if (action === 'approve') {
        assert(
          uiKeys(body, ['owner', 'slot', 'endpoint', 'roles', 'methods', 'headers', 'auth'], ['expectedRevision']),
        );
        assert(
          body.expectedRevision === undefined ||
            body.expectedRevision === null ||
            typeof body.expectedRevision === 'string',
        );
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
        assert(uiRecord(body.auth) && uiKeys(body.auth, ['kind'], ['header', 'value', 'revision']));
        const auth = body.auth as Record<string, unknown>;
        assert(['none', 'bearer', 'header', 'preserve'].includes(String(auth.kind)));
        let header: string | null = null,
          secret: string | null = null;
        if (auth.kind === 'preserve') assert(typeof auth.revision === 'string' && uiKeys(auth, ['kind', 'revision']));
        else if (auth.kind !== 'none') {
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
        await requirePluginConnectionAuthority(pool, scope, owner, String(body.slot), body.roles as string[]);
        await approvePluginEndpoint(String(body.endpoint), scope.origin, allowed, undefined, config.port);
        await identity(req);
        const id = randomUUID(),
          revision = randomUUID();
        const client = await pool.connect();
        try {
          await client.query('begin');
          // Serialize consent with the account state CAS, which retires old connections atomically.
          await client.query(
            'select revision from plugin_state_versions where account_id=$1 and library_id=$2 for update',
            [scope.accountId, scope.libraryId],
          );
          await requirePluginConnectionAuthority(client, scope, owner, String(body.slot), body.roles as string[]);
          await client.query('select account_id from plugin_account_identity where account_id=$1 for update', [
            scope.accountId,
          ]);
          const count = await client.query<{ count: string }>(
            'select count(*) from plugin_connections where account_id=$1',
            [scope.accountId],
          );
          const existing = await client.query<Connection>(
            'select * from plugin_connections where account_id=$1 and profile_id=$2 and installation_id=$3 for update',
            args.slice(0, 3),
          );
          const previous = existing.rows.find((r) => r.slot === body.slot);
          if (body.expectedRevision !== undefined) assert((previous?.revision ?? null) === body.expectedRevision);
          if (auth.kind === 'preserve') {
            assert(
              previous &&
                previous.revision === auth.revision &&
                previous.digest === owner.digest &&
                Number(previous.generation) === owner.generation &&
                previous.encrypted_secret &&
                previous.auth_header &&
                new URL(previous.endpoint).href === new URL(String(body.endpoint)).href,
            );
            header = previous!.auth_header;
            secret = open(previous!.encrypted_secret!, `${scope.accountId}:${previous!.id}:${previous!.revision}`);
          }
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
      if (action === 'cover' || action === 'image') {
        const isImage = action === 'image';
        if (isImage)
          assert(
            uiKeys(body, ['owner', 'requestId', 'revision', 'request']) &&
              typeof body.requestId === 'string' &&
              /^[a-f0-9-]{36}$/.test(body.requestId) &&
              typeof body.revision === 'string' &&
              pluginImageRequest(body.request),
          );
        else assert(uiKeys(body, ['owner', 'url']) && typeof body.url === 'string' && body.url.length <= 2048);
        const input = isImage
          ? (body.request as import('../../../../packages/extension-contracts/plugin-images').PluginImageRequest)
          : undefined;
        const target = isImage ? undefined : new URL(String(body.url));
        const load = async (db: Pick<pg.Pool, 'query'> = pool) => {
          const current = await identity(req, db);
          assert(current.accountId === scope.accountId && current.libraryId === scope.libraryId);
          const rows = await db.query<Connection>(`select * from plugin_connections where ${where}`, args);
          const row = rows.rows.find((connection) => {
            const base = new URL(connection.endpoint);
            if (input)
              return (
                connection.slot === input.slot &&
                connection.revision === body.revision &&
                connection.roles.includes('ui') &&
                connection.methods.includes('GET')
              );
            return (
              connection.roles.includes('controller') &&
              connection.methods.includes('GET') &&
              target!.origin === base.origin &&
              target!.pathname.startsWith(base.pathname)
            );
          });
          assert(row);
          await requirePluginConnectionAuthority(
            db,
            scope,
            owner,
            row!.slot,
            [isImage ? 'ui' : 'controller'],
            isImage ? 'ui.images' : undefined,
          );
          if (input) pluginTarget(row!.endpoint, input.path);
          return row!;
        };
        assert(
          pending.size < 16 &&
            [...pending.keys()].filter((key) => key.startsWith(prefix(scope.accountId, owner))).length < 4,
        );
        const key = prefix(scope.accountId, owner) + (isImage ? String(body.requestId) : randomUUID()),
          controller = new AbortController();
        if (isImage) {
          const now = Date.now();
          for (const [k, deadline] of seen) if (deadline < now) seen.delete(k);
          assert(!seen.has(key) && seen.size < 2048);
          seen.set(key, now + 60000);
        }
        assert(!pending.has(key));
        pending.set(key, { controller, owner });
        const timeout = setTimeout(() => controller.abort(), isImage ? 15000 : 10000);
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
          if (input?.cachedRevision === row.revision) {
            assert((await load()).revision === row.revision);
            controller.signal.throwIfAborted();
            reply.header('X-BOAA-Cache', 'validated');
            return { notModified: true, revision: row.revision };
          }
          const cacheKey = createHash('sha256')
            .update(
              JSON.stringify([
                isImage ? 'thumbnail-320-v1' : 'original-v1',
                row.revision,
                input ? pluginTarget(row.endpoint, input.path).href : String(body.url),
              ]),
            )
            .digest('hex');
          const cacheOwner = { ...scope, installationId: owner.installationId };
          const authorizeCache = async (db: Pick<pg.Pool, 'query'>) => {
            assert((await load(db)).revision === row.revision);
            controller.signal.throwIfAborted();
            return cacheAuthority(db, scope, owner);
          };
          const cached = await disposableCache(
            pool,
            cacheOwner,
            'image',
            { action: 'get', key: cacheKey },
            authorizeCache,
          ).catch(() => ({ found: false as const }));
          if (cached.found) {
            assert((await load()).revision === row.revision);
            controller.signal.throwIfAborted();
            reply.header('X-BOAA-Cache', 'hit');
            return isImage ? { ...(cached.value as object), revision: row.revision } : cached.value;
          }
          const result = await pluginCoverTransport(
            input ? pluginTarget(row.endpoint, input.path).href : String(body.url),
            row.endpoint,
            scope.origin,
            controller.signal,
            async () => {
              assert((await load()).revision === row.revision);
            },
            resolveDefaultProxy(),
          );
          const image = isImage ? await pluginImageThumbnail(result, controller.signal) : result;
          const current = await load();
          controller.signal.throwIfAborted();
          assert(current.revision === row.revision);
          await disposableCache(
            pool,
            cacheOwner,
            'image',
            { action: 'set', key: cacheKey, value: image as unknown as UiJson, ttlSeconds: 3600, staleSeconds: 0 },
            authorizeCache,
          ).catch(() => {});
          assert((await load()).revision === row.revision);
          controller.signal.throwIfAborted();
          reply.header('X-BOAA-Cache', 'miss');
          return isImage ? { ...image, revision: row.revision } : image;
        } finally {
          clearTimeout(timeout);
          clearInterval(poll);
          reply.raw.off('close', disconnect);
          pending.delete(key);
        }
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
        pending.get(key)?.controller.abort();
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
        await requirePluginConnectionAuthority(
          pool,
          scope,
          owner,
          input.slot,
          [String(body.role)],
          [
            ...(input.pick ? ['http.json-pick' as const] : []),
            ...(input.headers && Object.keys(input.headers).some((key) => key.toLowerCase() === 'origin')
              ? ['http.origin' as const]
              : []),
          ],
        );
        return row;
      };
      const controller = new AbortController();
      pending.set(key, { controller, owner });
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
          scope.origin,
          allowed,
          row.headers,
          config.port,
          controller.signal,
          async () => {
            await load();
          },
          resolveDefaultProxy(),
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
    for (const { controller } of pending.values()) controller.abort();
  });
}
