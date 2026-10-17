import { afterEach, expect, it, vi } from 'vitest';
import { RemoteApiClient } from './remote-api-client';
afterEach(() => vi.unstubAllGlobals());
it('requests immutable artwork by encoded asset/hash revision and isolates authenticated scopes', async () => {
  const fetch = vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' })));
  vi.stubGlobal('fetch', fetch);
  const a = new RemoteApiClient('/api', { getAuthToken: () => 'account-a' });
  const b = new RemoteApiClient('/api', { getAuthToken: () => 'account-b' });
  expect(a.coverCacheScope).not.toBe(b.coverCacheScope);
  expect(a.coverCacheScope).not.toContain('account-a');
  await a.getBookCover('book', 'asset:sha256:hash');
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/books/book/cover?v=asset%3Asha256%3Ahash',
    expect.objectContaining({ cache: 'force-cache' }),
  );
  await a.getBookCover('book');
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/books/book/cover',
    expect.not.objectContaining({ cache: 'force-cache' }),
  );
});
