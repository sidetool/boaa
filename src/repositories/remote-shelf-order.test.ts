import { afterEach, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteLibraryCatalogRepository } from './remote-library-catalog-repository';
afterEach(() => vi.unstubAllGlobals());
it('fails clearly on old servers without issuing independent shelf patches', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'Atomic shelf ordering is not supported by this server' }), { status: 404 }),
  );
  vi.stubGlobal('fetch', fetch);
  const repository = new RemoteLibraryCatalogRepository(new RemoteApiClient('/api'));
  await expect(
    repository.reorderShelves([
      { id: 'b', expectedRevision: 1 },
      { id: 'a', expectedRevision: 1 },
    ]),
  ).rejects.toMatchObject({ status: 404 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([
    '/api/shelves/order',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        order: [
          { id: 'b', expectedRevision: 1 },
          { id: 'a', expectedRevision: 1 },
        ],
      }),
    }),
  ]);
});
