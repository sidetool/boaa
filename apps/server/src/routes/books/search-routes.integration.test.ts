import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../config';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../services/id-v2-migration/postgres-integration-harness';
import { registerBookSearchRoutes } from './search-routes';

const harness = await startPostgresIntegrationHarness();
afterAll(() => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);

describe.skipIf(!harness)('hosted search with PostgreSQL', () => {
  it('pages literal matches across chapter boundaries in an owned book', async () => {
    await withPostgresSchema(harness!, 'reader_search', async (pool) => {
      await pool.query(`
        create table library_books(id text primary key, user_id text, deleted_at timestamptz);
        create table chapters(id text primary key, book_id text, chapter_index integer);
        create table paragraph_search(book_id text, chapter_id text, paragraph_index integer, paragraph jsonb, text_lower text);
        insert into library_books values ('book','owner',null), ('other','other',null), ('trash','owner',now());
        insert into chapters values ('b','book',2), ('a','book',1), ('c','other',1), ('d','trash',1);
        insert into paragraph_search
        select c.book_id, c.id, n, jsonb_build_object('id', c.id || n, 'novelId', c.book_id,
          'chapterId', c.id, 'index', n, 'text', '찾기%_', 'textHash', 'fixture',
          'startOffsetInChapter', 0, 'endOffsetInChapter', 4), case when n = 3 then '찾기글' else '찾기%_' end
        from chapters c cross join generate_series(1,3) n;
      `);
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.principal = { userId: 'owner', role: 'member', authMethod: 'session', sessionContext: 'fixture' };
      });
      await registerBookSearchRoutes(app, pool, { defaultUserId: 'owner' } as ServerConfig);
      const search = (book: string, options: Record<string, string>) =>
        app.inject({
          method: 'GET',
          url: `/api/books/${book}/search?${new URLSearchParams({ query: '찾기%_', ...options })}`,
        });
      try {
        const first = await search('book', { pageSize: '2' });
        expect(first.statusCode).toBe(200);
        expect(first.json().paragraphs.map((p: { id: string }) => p.id)).toEqual(['a1', 'a2']);
        const second = await search('book', { pageSize: '2', cursor: first.json().nextCursor });
        expect(second.json().paragraphs.map((p: { id: string }) => p.id)).toEqual(['b1', 'b2']);
        expect(second.json()).not.toHaveProperty('nextCursor');
        const legacy = await search('book', { limit: '3' });
        expect(legacy.json().paragraphs.map((p: { id: string }) => p.id)).toEqual(['a1', 'a2', 'b1']);
        expect((await search('book', { query: '없음' })).json()).toEqual({ paragraphs: [] });
        for (const book of ['other', 'trash', 'missing'])
          expect((await search(book, { pageSize: '2' })).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
