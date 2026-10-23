import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginImages, IMAGE_CACHE_LIMITS } from './images';
import type { UiJson } from '../../../../packages/extension-contracts/ui-json';
const revision = '11111111-1111-4111-8111-111111111111';
const dto = (extra = {}) => ({ mime: 'image/png', data: btoa('fixture'), width: 56, height: 78, revision, ...extra });
const input = (path = 'a.png') => ({ slot: 'covers', path });
const instances: PluginImages[] = [];
const create = (request: ConstructorParameters<typeof PluginImages>[0], available?: () => boolean) => {
  const images = new PluginImages(request, available);
  instances.push(images);
  return images;
};
beforeEach(() => {
  let count = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${++count}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  instances.splice(0).forEach((i) => i.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('shares pending consumers, reauthorizes cache hits and revokes all URLs on close', async () => {
  let resolve!: (v: UiJson) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<UiJson>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({ notModified: true, revision });
  const images = create(request);
  const a = images.load(input()),
    b = images.load(input());
  expect(request).toHaveBeenCalledTimes(1);
  resolve(dto());
  const [first, second] = await Promise.all([a, b]);
  expect(first.url).toBe(second.url);
  first.dispose();
  first.dispose();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  const third = await images.load(input());
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][1]).toEqual({ ...input(), cachedRevision: revision });
  expect(third.url).toBe(second.url);
  images.close();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  second.dispose();
  third.dispose();
});
it('cancelling one shared consumer preserves the other; cancelling the last rejects late bytes without a URL', async () => {
  const resolvers: Array<(v: UiJson) => void> = [],
    signals: AbortSignal[] = [];
  const images = create((_m, _i, signal) => {
    signals.push(signal!);
    return new Promise((r) => resolvers.push(r));
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = images.load(input(), a.signal),
    second = images.load(input(), b.signal);
  a.abort();
  await expect(first).rejects.toThrow('CANCELLED');
  expect(signals[0].aborted).toBe(false);
  resolvers[0](dto());
  const lease = await second;
  lease.dispose();
  const c = new AbortController(),
    late = images.load(input('late.png'), c.signal);
  c.abort();
  await expect(late).rejects.toThrow('CANCELLED');
  expect(signals[1].aborted).toBe(true);
  resolvers[1](dto());
  await new Promise((r) => setTimeout(r, 0));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
it('denied cached authority invalidates an existing URL, and revision replacement creates a fresh URL', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(dto())
    .mockResolvedValueOnce(dto({ revision: '22222222-2222-4222-8222-222222222222' }))
    .mockRejectedValueOnce(Error('DENIED'));
  const images = create(request),
    a = await images.load(input()),
    b = await images.load(input());
  expect(b.url).not.toBe(a.url);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(a.url);
  await expect(images.load(input())).rejects.toThrow('DENIED');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(b.url);
});
it('evicts only unused LRU entries and refuses to exceed the leased entry limit', async () => {
  const images = create(async () => dto());
  const leases = [];
  for (let n = 0; n < IMAGE_CACHE_LIMITS.entries; n++) leases.push(await images.load(input(`${n}.png`)));
  await expect(images.load(input('overflow.png'))).rejects.toThrow('IMAGE_LIMIT');
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  leases[0].dispose();
  await images.load(input('replacement.png'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(leases[0].url);
});
it('bounds encoded and decoded cache memory even below the item limit', async () => {
  const images = create(async () => dto({ data: btoa('x'.repeat(512 * 1024)), width: 480, height: 720 }));
  for (let n = 0; n < 8; n++) await images.load(input(`${n}.png`));
  await expect(images.load(input('too-much.png'))).rejects.toThrow('IMAGE_LIMIT');
  expect(URL.createObjectURL).toHaveBeenCalledTimes(8);
});
it.each([
  { width: 481 },
  { height: 721 },
  { data: 'not-base64' },
  { data: btoa('x'.repeat(512 * 1024 + 1)) },
  { notModified: true, revision },
])('rejects malformed or oversized image DTO %#', async (value) => {
  const images = create(async () => ('notModified' in value ? value : dto(value)) as UiJson);
  await expect(images.load(input())).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('honors the two-image scheduler and leaves control RPC capacity available', async () => {
  vi.useFakeTimers();
  let available = false;
  const resolve: Array<(v: UiJson) => void> = [];
  const request = vi.fn(() => new Promise<UiJson>((r) => resolve.push(r)));
  const images = create(request, () => available);
  const jobs = [images.load(input('1')), images.load(input('2')), images.load(input('3'))];
  expect(request).not.toHaveBeenCalled();
  available = true;
  await vi.advanceTimersByTimeAsync(20);
  expect(request).toHaveBeenCalledTimes(2);
  resolve[0](dto());
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3);
  resolve[1](dto());
  resolve[2](dto());
  await Promise.all(jobs);
});
it('refreshes expired entries and releases settled leases on abort', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (_method: string, _input: UiJson) => dto()),
    images = create(request),
    abort = new AbortController();
  await images.load(input(), abort.signal);
  abort.abort();
  await vi.advanceTimersByTimeAsync(IMAGE_CACHE_LIMITS.ttlMs + 1);
  await images.load(input());
  expect(request.mock.calls[1][1]).not.toHaveProperty('cachedRevision');
});
it('immediately frees a cancelled queued reservation while the two active requests remain held', async () => {
  let available = false;
  const images = create(
    async () => dto(),
    () => available,
  );
  const abort = new AbortController();
  const queued = images.load(input('cancelled'), abort.signal);
  const rejection = expect(queued).rejects.toThrow('CANCELLED');
  const jobs = Array.from({ length: 31 }, (_, n) => images.load(input(`${n}`)));
  abort.abort();
  await rejection;
  jobs.push(images.load(input('replacement')));
  available = true;
  await Promise.all(jobs.map(async (p) => (await p).dispose()));
});
it('keeps another consumer URL alive during a same-revision TTL refresh', async () => {
  vi.useFakeTimers();
  const images = create(async () => dto());
  const first = await images.load(input());
  await vi.advanceTimersByTimeAsync(IMAGE_CACHE_LIMITS.ttlMs + 1);
  const second = await images.load(input());
  expect(second.url).toBe(first.url);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  second.dispose();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  first.dispose();
});
