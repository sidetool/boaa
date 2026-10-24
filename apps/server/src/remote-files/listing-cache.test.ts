import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteListingCache } from './listing-cache.js';
import { RemoteListingStore } from './listing-store.js';
import { RemoteFileService } from './service.js';
import { SessionSourceCredentialVault } from '../extensions/source-credential-vault.js';
import { Readable } from 'node:stream';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const entry = (name = 'book') => ({ name, path: '/' + name, directory: true });
const args = (load = vi.fn(async () => [entry()])) => ({
  owner: 'owner',
  connection: 'c',
  key: 'key',
  signal: new AbortController().signal,
  load,
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
it('keeps snapshots indefinitely across runtime restart, refreshes explicitly and preserves a failed refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-listing-cache-'));
  roots.push(root);
  let now = Date.now();
  const load = vi.fn(async () => [entry()]);
  const input = args(load);
  const cache = new RemoteListingCache(() => now, new RemoteListingStore(root));
  const first = await cache.get(input);
  now += 365 * 24 * 60 * 60_000;
  const restarted = new RemoteListingCache(() => now, new RemoteListingStore(root));
  expect((await restarted.get(input)).id).toBe(first.id);
  expect(load).toHaveBeenCalledOnce();
  load.mockRejectedValueOnce(new Error('offline'));
  await expect(restarted.get({ ...input, reload: true })).rejects.toThrow('offline');
  expect((await restarted.get(input)).id).toBe(first.id);
  load.mockResolvedValueOnce([entry('updated')]);
  const fresh = await restarted.get({ ...input, reload: true });
  expect(fresh.id).not.toBe(first.id);
  expect((await restarted.get({ ...input, snapshot: first.id })).entries).toEqual(first.entries);
  expect((await restarted.get(input)).id).toBe(fresh.id);
  for (const file of await readdir(root)) expect((await stat(join(root, file))).mode & 0o777).toBe(0o600);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  await restarted.invalidate('owner', 'c');
  const store = new RemoteListingStore(root);
  expect(await store.read('owner', 'c', 'key')).toBeUndefined();
});
it('coalesces scans, cancels a single consumer independently, and never saves an abandoned scan', async () => {
  const pending = deferred<ReturnType<typeof entry>[]>();
  const load = vi.fn(async (_signal: AbortSignal) => pending.promise);
  const one = new AbortController(),
    two = new AbortController();
  const cache = new RemoteListingCache();
  const input = { ...args(), load };
  const a = cache.get({ ...input, signal: one.signal });
  const b = cache.get({ ...input, signal: two.signal });
  await Promise.resolve();
  one.abort();
  await expect(a).rejects.toThrow();
  expect(load.mock.calls[0][0].aborted).toBe(false);
  pending.resolve([entry()]);
  const row = await b;
  expect((await cache.get(input)).id).toBe(row.id);
  expect(load).toHaveBeenCalledOnce();
  const abandoned = deferred<ReturnType<typeof entry>[]>();
  const abort = new AbortController();
  const last = cache.get({ ...input, key: 'other', signal: abort.signal, load: async () => abandoned.promise });
  await Promise.resolve();
  abort.abort();
  await expect(last).rejects.toThrow();
  abandoned.resolve([entry('old')]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await cache.get({ ...args(), key: 'other' })).entries).toEqual([entry()]);
});
it('bounds concurrent upstream scans and rejects oversized listings before caching them', async () => {
  const gate = deferred<ReturnType<typeof entry>[]>();
  const cache = new RemoteListingCache();
  const input = { ...args(), load: async () => gate.promise };
  const a = cache.get(input),
    b = cache.get({ ...input, key: 'second' });
  await expect(cache.get({ ...input, key: 'third' })).rejects.toThrow('busy');
  gate.resolve([entry()]);
  await Promise.all([a, b]);
  await expect(cache.get({ ...args(), key: 'huge', load: async () => Array(50_001).fill(entry()) })).rejects.toThrow(
    'listing_limit',
  );
  const huge = { ...entry(), name: 'x'.repeat(4096) };
  await expect(cache.get({ ...args(), key: 'bytes', load: async () => Array(7000).fill(huge) })).rejects.toThrow(
    'listing_limit',
  );
});
it('treats corrupt persistent snapshots as cache misses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-listing-corrupt-'));
  roots.push(root);
  const input = args();
  const cache = new RemoteListingCache(Date.now, new RemoteListingStore(root));
  await cache.get(input);
  const file = join(root, (await readdir(root))[0]);
  const row = JSON.parse(await readFile(file, 'utf8'));
  row.entries = [entry('../escape')];
  await writeFile(file, JSON.stringify(row));
  await new RemoteListingCache(Date.now, new RemoteListingStore(root)).get(input);
  expect(input.load).toHaveBeenCalledTimes(2);
});
it('binds cursors to account, connection, folder, query and snapshot; config updates invalidate them', async () => {
  let rows = Array.from({ length: 401 }, (_, i) => entry('folder' + i));
  const list = vi.fn(async () => rows);
  const check = vi.fn(async () => {});
  const service = new RemoteFileService(new SessionSourceCredentialVault(), async () => ({
    check,
    list,
    download: async () => Readable.from([]),
    close() {},
  }));
  const config = { name: 'NAS', endpoint: 'https://nas.example/', username: 'u', password: 'p' };
  const saved = await service.connect('a', 'webdav', config, new AbortController().signal);
  expect(list).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalledOnce();
  const request = { generation: saved.generation };
  const signal = new AbortController().signal;
  const first = await service.list('a', saved.id!, request, signal);
  rows = [entry('replacement')];
  await service.list('a', saved.id!, { ...request, reload: true }, signal);
  const second = await service.list('a', saved.id!, { ...request, cursor: first.nextCursor }, signal);
  expect(second.entries).toHaveLength(200);
  expect(list).toHaveBeenCalledTimes(2);
  await expect(service.list('b', saved.id!, request, signal)).rejects.toThrow('not_connected');
  await expect(
    service.list('a', saved.id!, { ...request, path: '/elsewhere', cursor: first.nextCursor }, signal),
  ).rejects.toThrow('listing_expired');
  await expect(
    service.list('a', saved.id!, { ...request, query: 'different', cursor: first.nextCursor }, signal),
  ).rejects.toThrow('invalid_request');
  const updated = await service.connect('a', 'webdav', config, signal, saved.id);
  await expect(service.list('a', saved.id!, request, signal)).rejects.toThrow('connection_changed');
  await expect(
    service.list('a', saved.id!, { generation: updated.generation, cursor: first.nextCursor }, signal),
  ).rejects.toThrow('listing_expired');
});

it('rejects in-flight metadata after connection revocation and cannot repopulate the cache', async () => {
  const gate = deferred<ReturnType<typeof entry>[]>();
  const cache = new RemoteListingCache();
  const input = { ...args(), load: async () => gate.promise };
  const pending = cache.get(input);
  await Promise.resolve();
  await cache.invalidate('owner', 'c');
  gate.resolve([entry('revoked')]);
  await expect(pending).rejects.toThrow('connection_changed');
  expect((await cache.get(args())).entries).toEqual([entry()]);
});
