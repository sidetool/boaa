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

it('reads shelves and memberships once per refresh without reusing pre-mutation reads or failed requests', async () => {
  let finish!: (value: { shelves: Record<string, unknown>[]; memberships: Record<string, unknown>[] }) => void;
  const old = new Promise<{ shelves: Record<string, unknown>[]; memberships: Record<string, unknown>[] }>((resolve) => {
    finish = resolve;
  });
  const row = {
    id: 'shelf',
    name: 'Fresh',
    sortOrder: 0,
    revision: 2,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
  };
  const listShelves = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce({ shelves: [row], memberships: [] })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ shelves: [], memberships: [] });
  const repository = new RemoteLibraryCatalogRepository({ listShelves } as unknown as RemoteApiClient);
  const previous = repository.listShelfCatalog();
  expect((await repository.listShelfCatalog()).shelves[0]).toMatchObject({ name: 'Fresh', revision: 2 });
  finish({ shelves: [], memberships: [] });
  expect(await previous).toEqual({ shelves: [], memberships: [] });
  await expect(repository.listShelfCatalog()).rejects.toThrow('offline');
  await expect(repository.listShelfCatalog()).resolves.toEqual({ shelves: [], memberships: [] });
  expect(listShelves).toHaveBeenCalledTimes(4);
  const otherList = vi.fn().mockResolvedValue({ shelves: [], memberships: [] });
  await new RemoteLibraryCatalogRepository({ listShelves: otherList } as unknown as RemoteApiClient).listShelfCatalog();
  expect(otherList).toHaveBeenCalledOnce();
  expect(listShelves).toHaveBeenCalledTimes(4);
});
