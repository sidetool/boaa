import { afterEach, expect, it, vi } from 'vitest';
import { PluginHomeRuntime } from './home-runtime';
import type { Installation } from './store-model';
import type { PluginHttp } from './plugin-http';

const image = 'https://example.invalid/cover.png';
const payload = { mime: 'image/png', data: btoa('synthetic-image') };
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
});
async function fixture() {
  const row = {
    pluginId: 'org.example.feed',
    installationId: 'install',
    active: 'digest',
    revision: 1,
    enabled: true,
    manifest: {
      extension: { name: 'Synthetic' },
      contributes: { homeSections: [{ id: 'popular', title: 'Popular' }] },
    },
  } as Installation;
  let rows = [row];
  const host = {
    list: vi.fn(async () => rows),
    invoke: vi.fn(async () => ({ ok: true, value: { items: [{ id: 'one', title: 'Example', coverUrl: image }] } })),
  };
  const http = {
    owner: vi.fn(() => ({})),
    host: vi.fn().mockResolvedValue(payload),
    list: vi
      .fn()
      .mockResolvedValue([
        { endpoint: 'https://example.invalid/', roles: ['controller'], methods: ['GET'], revision: 'connection-1' },
      ]),
  };
  const runtime = new PluginHomeRuntime(host, http as unknown as PluginHttp);
  cleanup.push(() => runtime.close());
  let sequence = 0;
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:synthetic-${++sequence}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await runtime.feed(row.pluginId, 'popular');
  return {
    row,
    runtime,
    host,
    http,
    create,
    revoke,
    setRows: (next: Installation[]) => {
      rows = next;
      runtime.reconcile(rows);
    },
  };
}
it('shares simultaneous cover requests without leaking URLs and isolates consumer cancellation', async () => {
  const f = await fixture();
  let resolve!: (value: typeof payload) => void;
  f.http.host.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const abort = new AbortController();
  const first = f.runtime.cover(f.row.pluginId, 'popular', image, abort.signal);
  const cancelled = expect(first).rejects.toThrow();
  const second = f.runtime.cover(f.row.pluginId, 'popular', image);
  await vi.waitFor(() => expect(f.http.host).toHaveBeenCalledOnce());
  abort.abort();
  await cancelled;
  expect((f.http.host.mock.lastCall![3] as AbortSignal).aborted).toBe(false);
  resolve(payload);
  await expect(second).resolves.toBe('blob:synthetic-1');
  expect(f.create).toHaveBeenCalledOnce();
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image)).resolves.toBe('blob:synthetic-1');
  expect(f.http.host).toHaveBeenCalledOnce();
  f.runtime.close();
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-1');
});
it('rechecks consent for a cached home cover and revokes its URL after withdrawal', async () => {
  const f = await fixture();
  await f.runtime.cover(f.row.pluginId, 'popular', image);
  expect(f.runtime.coverSnapshot(f.row.pluginId, 'popular', image)).toBe('blob:synthetic-1');
  f.http.list.mockResolvedValue([]);
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image)).rejects.toThrow('HOME_COVER_DENIED');
  expect(f.revoke).toHaveBeenCalledWith('blob:synthetic-1');
  expect(f.runtime.coverSnapshot(f.row.pluginId, 'popular', image)).toBeUndefined();
  expect(f.http.host).toHaveBeenCalledOnce();
});
it('preserves unaffected feed and cover cache when another plugin changes', async () => {
  const f = await fixture();
  await f.runtime.cover(f.row.pluginId, 'popular', image);
  f.setRows([f.row, { ...f.row, pluginId: 'org.example.other', installationId: 'other', revision: 2 }]);
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image)).resolves.toBe('blob:synthetic-1');
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.http.host).toHaveBeenCalledOnce();
  f.setRows([{ ...f.row, enabled: false }]);
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-1');
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image)).rejects.toThrow('PACKAGE_UNAVAILABLE');
});
it('aborts retired cover fetches and discards late responses even when transport ignores abort', async () => {
  const f = await fixture();
  let resolve!: (value: typeof payload) => void;
  f.http.host.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.runtime.cover(f.row.pluginId, 'popular', image);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.http.host).toHaveBeenCalledOnce());
  f.setRows([{ ...f.row, active: 'replacement', revision: 2 }]);
  expect((f.http.host.mock.lastCall![3] as AbortSignal).aborted).toBe(true);
  resolve(payload);
  await rejected;
  expect(f.create).not.toHaveBeenCalled();
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image)).rejects.toThrow('HOME_COVER_DENIED');
});
it('honors cancellation even for cached covers and rejects images outside the accepted feed', async () => {
  const f = await fixture();
  await f.runtime.cover(f.row.pluginId, 'popular', image);
  const abort = new AbortController();
  abort.abort();
  await expect(f.runtime.cover(f.row.pluginId, 'popular', image, abort.signal)).rejects.toThrow();
  await expect(f.runtime.cover(f.row.pluginId, 'popular', 'https://example.invalid/unlisted.png')).rejects.toThrow(
    'HOME_COVER_DENIED',
  );
  expect(f.http.host).toHaveBeenCalledOnce();
});
