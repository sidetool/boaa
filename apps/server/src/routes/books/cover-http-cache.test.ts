import Fastify from 'fastify';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../config.js';
import { registerBookCoverRoutes } from './cover-routes.js';
const storage = vi.hoisted(() => ({ get: vi.fn(async () => ({ body: Buffer.from('image') })) }));
vi.mock('../../services/object-storage.js', () => ({ createS3Client: vi.fn(), getObjectBuffer: storage.get }));

describe('versioned book artwork', () => {
  it('caches exact revisions for one year, rejects outdated revisions, and revalidates unversioned clients', async () => {
    let cover = {
      id: 'asset-1',
      content_hash: 'sha256:first',
      content_type: 'image/png',
      storage_key: 'key',
      provenance: 'user_supplied',
      status: 'active',
    };
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [cover] }));
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.principal = { userId: 'user', role: 'admin', authMethod: 'legacy-token' };
    });
    await registerBookCoverRoutes(app, { query } as unknown as pg.Pool, { defaultUserId: 'user' } as ServerConfig);
    try {
      const first = await app.inject('/api/books/book/cover?v=asset-1%3Asha256%3Afirst');
      expect(first.statusCode).toBe(200);
      expect(first.headers.vary).toBe('Authorization, Cookie');
      expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(first.headers.etag).toBe('"sha256:first"');
      expect(query.mock.calls[0]?.[1]).toEqual(['book', 'user']);
      cover = { ...cover, id: 'asset-2', content_hash: 'sha256:second' };
      storage.get.mockClear();
      const old = await app.inject('/api/books/book/cover?v=asset-1%3Asha256%3Afirst');
      expect(old.statusCode).toBe(409);
      expect(old.headers['cache-control']).toBe('no-store');
      expect(storage.get).not.toHaveBeenCalled();
      const next = await app.inject('/api/books/book/cover?v=asset-2%3Asha256%3Asecond');
      expect(next.statusCode).toBe(200);
      expect(next.headers['cache-control']).toContain('immutable');
      expect((await app.inject('/api/books/book/cover')).headers['cache-control']).toBe('private, no-cache');
    } finally {
      await app.close();
    }
  });
});
