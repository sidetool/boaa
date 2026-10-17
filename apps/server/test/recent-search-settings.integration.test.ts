import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { RemoteReaderRepository } from '../../../src/repositories/remote-reader-repository.js';
import { RemoteApiClient } from '../../../src/services/remote/remote-api-client.js';
import { resetReaderDbForTests } from '../../../src/storage/reader-database.js';
import type { ServerConfig } from '../src/config.js';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../src/services/id-v2-migration/postgres-integration-harness.js';
import { registerReaderStateRoutes } from '../src/routes/books/reader-state-routes.js';

const harness = await startPostgresIntegrationHarness();
(harness ? describe : describe.skip)('recent searches through HTTP and PostgreSQL', () => {
  afterAll(async () => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);

  test('survives a fresh server, client and browser store, including removal and clear', async () => {
    await withPostgresSchema(harness!, 'recent_search_settings', async (pool) => {
      await pool.query(
        'create table reader_settings (user_id text primary key, settings jsonb not null, updated_at timestamptz not null)',
      );
      await pool.query(
        'create table sync_events (id text primary key, user_id text, device_id text, type text, book_id text, entity_id text, payload jsonb, revision jsonb, created_at timestamptz)',
      );
      const apps: ReturnType<typeof Fastify>[] = [];
      const start = async (userId = 'one') => {
        const app = Fastify();
        apps.push(app);
        await registerReaderStateRoutes(app, pool, { defaultUserId: userId } as ServerConfig);
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const client = new RemoteApiClient(`${address}/api`);
        return { app, client, repository: new RemoteReaderRepository(client) };
      };
      const readStored = async () =>
        (await pool.query("select settings from reader_settings where user_id = 'one'")).rows[0].settings;

      try {
        await resetReaderDbForTests();
        const first = await start();
        const recentSearches = ['zz', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
        await first.repository.saveSettings({ ...(await first.repository.getSettings()), recentSearches });
        expect((await readStored()).recentSearches).toEqual(recentSearches);
        expect((await first.client.getSettings()).settings.recentSearches).toEqual(recentSearches);
        const events = (await pool.query('select payload from sync_events')).rows;
        expect(events).toEqual([{ payload: { settings: expect.objectContaining({ recentSearches }) } }]);
        await first.app.close();
        await resetReaderDbForTests();

        const fresh = await start();
        expect((await fresh.repository.getSettings()).recentSearches).toEqual(recentSearches);
        const other = await start('two');
        expect((await other.repository.getSettings()).recentSearches).toBeUndefined();

        // Older clients omit this field when saving unrelated settings.
        await fresh.client.saveSettings({ ttsSpeed: 1.5 });
        expect((await new RemoteReaderRepository(fresh.client).getSettings()).recentSearches).toEqual(recentSearches);
        for (const invalid of [['x'.repeat(201)], Array.from({ length: 9 }, (_, i) => String(i)), [42], [' ']]) {
          const response = await fresh.app.inject({
            method: 'PUT',
            url: '/api/settings',
            payload: { recentSearches: invalid },
          });
          expect(response.statusCode).toBe(400);
          expect((await readStored()).recentSearches).toEqual(recentSearches);
        }

        const normalized = await fresh.app.inject({
          method: 'PUT',
          url: '/api/settings',
          payload: { recentSearches: [' zz ', 'ZZ', 'second'] },
        });
        expect(normalized.statusCode).toBe(200);
        expect(normalized.json().settings.recentSearches).toEqual(['zz', 'second']);
        expect((await fresh.repository.getSettings()).recentSearches).toEqual(['zz', 'second']);

        await fresh.repository.saveSettings({ ...(await fresh.repository.getSettings()), recentSearches: ['second'] });
        expect((await new RemoteReaderRepository(fresh.client).getSettings()).recentSearches).toEqual(['second']);
        await fresh.repository.saveSettings({ ...(await fresh.repository.getSettings()), recentSearches: [] });
        await fresh.app.close();
        await resetReaderDbForTests();
        const cleared = await start();
        expect((await cleared.repository.getSettings()).recentSearches).toEqual([]);
        expect((await readStored()).recentSearches).toEqual([]);
      } finally {
        await Promise.all(apps.map((app) => app.close()));
        await resetReaderDbForTests();
      }
    });
  });
});
