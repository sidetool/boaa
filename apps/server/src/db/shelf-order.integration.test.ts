import Fastify from 'fastify';
import { afterAll, expect, test, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { migrateDatabase } from './migrate.js';
import { registerLibraryManagementRoutes } from '../routes/books/library-management-routes.js';
import { reorderHostedShelves } from '../services/hosted-library-management-service.js';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { RemoteApiClient } from '../../../../src/services/remote/remote-api-client';
import { RemoteLibraryCatalogRepository } from '../../../../src/repositories/remote-library-catalog-repository';

// This suite must own its database, never use a developer's configured database.
for (const key of [
  'TEST_DATABASE_URL',
  'BOAA_TEST_DATABASE_URL',
  'MOYA_TEST_DATABASE_URL',
  'NOVELDESK_TEST_DATABASE_URL',
  'MOA_TEST_DATABASE_URL',
  'POSTGRES_TEST_URL',
]) {
  if (process.env[key]) throw new Error(`Unset ${key}: shelf-order integration requires a harness-owned database`);
}
const harness = await startPostgresIntegrationHarness();
if (!harness) throw new Error('Owned PostgreSQL harness unavailable: shelf atomicity was not tested');
afterAll(() => harness.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);

test('remote reorder repairs ties atomically, fences revisions and isolates owners', async () => {
  await withPostgresSchema(harness, 'shelf_order', async (pool) => {
    await migrateDatabase(pool);
    await pool.query(
      "insert into users (id, email, display_name) values ('owner', 'owner@example.test', 'Owner'), ('other', 'other@example.test', 'Other')",
    );
    await pool.query(
      "insert into shelves (id, user_id, name, color, sort_order, revision) values ('a', 'owner', 'A', '#abcdef', 0, 1), ('b', 'owner', 'B', null, 0, 1), ('private', 'other', 'Private', null, 0, 1)",
    );
    const config = { defaultUserId: 'owner' } as ServerConfig;
    const app = Fastify();
    await registerLibraryManagementRoutes(app, pool, config);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'PUT',
        url,
        headers,
        payload: init?.body as string | undefined,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const repository = new RemoteLibraryCatalogRepository(new RemoteApiClient('/api'));
    const snapshot = async () => ({
      shelves: (await pool.query('select * from shelves order by id')).rows,
      events: (await pool.query('select * from sync_events order by id')).rows,
    });
    try {
      const before = await snapshot();
      for (const order of [
        [],
        [{ id: 'a', expectedRevision: 1 }],
        [
          { id: 'a', expectedRevision: 1 },
          { id: 'private', expectedRevision: 1 },
        ],
        [
          { id: 'a', expectedRevision: 1 },
          { id: 'b', expectedRevision: 99 },
        ],
      ]) {
        await expect(repository.reorderShelves(order)).rejects.toMatchObject({ status: 409 });
        expect(await snapshot()).toEqual(before);
      }
      for (const order of [
        [
          { id: 'a', expectedRevision: 1 },
          { id: 'a', expectedRevision: 1 },
        ],
        [{ id: 'a', expectedRevision: 1.1 }],
        Array.from({ length: 10002 }, (_, i) => ({ id: String(i), expectedRevision: 1 })),
      ]) {
        const result = await app.inject({ method: 'PUT', url: '/api/shelves/order', payload: { order } });
        expect(result.statusCode).toBe(400);
        expect(await snapshot()).toEqual(before);
      }
      const shelves = await repository.reorderShelves([
        { id: 'b', expectedRevision: 1 },
        { id: 'a', expectedRevision: 1 },
      ]);
      expect(shelves.map((shelf) => [shelf.id, shelf.sortOrder, shelf.revision])).toEqual([
        ['b', 0, 1],
        ['a', 1, 2],
      ]);
      expect(shelves[1]).toMatchObject({ name: 'A', color: '#abcdef' });
      expect((await snapshot()).shelves.find((row) => row.id === 'private')).toEqual(
        before.shelves.find((row) => row.id === 'private'),
      );
      expect((await snapshot()).events).toHaveLength(1);
      // The same snapshot can win only once, even when requests race.
      const next = [
        { id: 'a', expectedRevision: 2 },
        { id: 'b', expectedRevision: 1 },
      ];
      const results = await Promise.allSettled([repository.reorderShelves(next), repository.reorderShelves(next)]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await repository.listShelves()).map((shelf) => [shelf.id, shelf.sortOrder, shelf.revision])).toEqual([
        ['a', 0, 3],
        ['b', 1, 2],
      ]);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});

test.each(['b', 'a'])('rolls back all ranks, revisions and events when updating %s fails', async (failedId) => {
  await withPostgresSchema(harness, 'shelf_rollback', async (pool) => {
    await migrateDatabase(pool);
    await pool.query("insert into users (id, email, display_name) values ('owner', 'owner@example.test', 'Owner')");
    await pool.query(
      "insert into shelves (id, user_id, name, sort_order, revision) values ('a', 'owner', 'A', 0, 1), ('b', 'owner', 'B', 1, 1)",
    );
    await pool.query(
      `create function reject_shelf_write() returns trigger language plpgsql as $$ begin if NEW.id = '${failedId}' then raise exception 'injected shelf failure'; end if; return NEW; end $$`,
    );
    await pool.query(
      'create trigger fail_shelf before update on shelves for each row execute function reject_shelf_write()',
    );
    const before = (await pool.query('select * from shelves order by id')).rows;
    await expect(
      reorderHostedShelves(pool, { defaultUserId: 'owner' } as ServerConfig, [
        { id: 'b', expectedRevision: 1 },
        { id: 'a', expectedRevision: 1 },
      ]),
    ).rejects.toThrow('injected shelf failure');
    expect((await pool.query('select * from shelves order by id')).rows).toEqual(before);
    expect((await pool.query('select * from sync_events')).rows).toEqual([]);
  });
});
