import { afterEach, expect, it, vi } from 'vitest';
import { SessionCoverCache } from './session-cover-cache';
import { DiscoverySession } from '../features/discovery/discovery-session';
import type { ExternalSourceRegistryPort } from './app-external-source-registry';
import type { TrustedExternalSourceHostContext } from './contracts';

const image = () => new Blob(['fixture'], { type: 'image/png' });
const key = (id: number) => JSON.stringify(['fixture.source', 'generation', String(id)]);
function fixture() {
  const cache = new SessionCoverCache();
  let live = 0,
    maximum = 0;
  const jobs: Array<{ signal: AbortSignal; finish: () => void }> = [];
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<Blob>((resolve) => {
        live++;
        maximum = Math.max(maximum, live);
        // Deliberately ignore cancellation: only actual completion returns a permit.
        jobs.push({
          signal,
          finish: () => {
            live--;
            resolve(image());
          },
        });
      }),
  );
  const registry = {
    peekExternalSourceCover: (_id, _context, item) => cache.peek(key(Number(item.remoteId))),
    resolveExternalSourceCover: (_id, _context, item, signal) =>
      cache.resolve(key(Number(item.remoteId)), load, signal),
  } as ExternalSourceRegistryPort;
  const session = () => new DiscoverySession(registry, {} as TrustedExternalSourceHostContext);
  const cover = (s: DiscoverySession, id: number, owner: AbortController) =>
    s.cover({ connectorId: 'fixture.source', remoteId: String(id) }, owner.signal);
  return { cache, load, jobs, session, cover, live: () => live, maximum: () => maximum };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the shared loader until the last consumer leaves, rejects immediately, and suppresses late publication', async () => {
  const h = fixture(),
    a = new AbortController(),
    b = new AbortController();
  const create = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  const first = h.cache.resolve(key(0), h.load, a.signal).catch((error) => error);
  const second = h.cache.resolve(key(0), h.load, b.signal).catch((error) => error);
  a.abort();
  expect(await first).toBe(a.signal.reason);
  expect(h.jobs[0].signal.aborted).toBe(false);
  b.abort();
  expect(await second).toBe(b.signal.reason);
  expect(h.jobs[0].signal.aborted).toBe(true);
  expect(h.live()).toBe(1);
  h.jobs[0].finish();
  await vi.waitFor(() => expect(h.live()).toBe(0));
  expect(create).not.toHaveBeenCalled();
  h.cache.clear();
});

it('bounds actual I/O across sessions and viewport batches even after all consumers abort', async () => {
  const h = fixture(),
    s1 = h.session(),
    s2 = h.session();
  for (let batch = 0; batch < 3; batch++) {
    const owners = Array.from({ length: 4 }, () => new AbortController());
    const requests = owners.map((owner, i) =>
      h.cover(batch % 2 ? s2 : s1, batch * 4 + i, owner).catch((error) => error),
    );
    await Promise.resolve();
    owners.forEach((owner) => owner.abort());
    await Promise.all(requests);
    expect(h.live()).toBe(4);
    expect(h.jobs).toHaveLength(4);
  }
  h.jobs.forEach((job) => job.finish());
  await vi.waitFor(() => expect(h.live()).toBe(0));
  const next = h.cover(s1, 12, new AbortController());
  await vi.waitFor(() => expect(h.jobs).toHaveLength(5));
  h.jobs[4].finish();
  expect(await next).toMatch(/^blob:/);
  expect(h.maximum()).toBe(4);
  s1.dispose();
  s2.dispose();
  h.cache.clear();
});

it('returns twelve stale URLs immediately while bounding and owning all background revalidations', async () => {
  const h = fixture(),
    s = h.session();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const old = await Promise.all(
    Array.from({ length: 12 }, (_, i) => h.cache.resolve(key(i), async () => image(), new AbortController().signal)),
  );
  now += 31 * 86400_000;
  const owners = Array.from({ length: 12 }, () => new AbortController());
  expect(await Promise.all(owners.map((owner, i) => h.cover(s, i, owner)))).toEqual(old);
  expect(h.jobs).toHaveLength(4);
  // Cancel a queued retained consumer, then let a running refresh finish.
  owners[4].abort();
  h.jobs[0].finish();
  await vi.waitFor(() => expect(h.jobs).toHaveLength(5));
  expect(h.maximum()).toBe(4);
  s.dispose();
  expect(h.jobs.slice(1).every((job) => job.signal.aborted)).toBe(true);
  h.jobs.slice(1).forEach((job) => job.finish());
  await vi.waitFor(() => expect(h.live()).toBe(0));
  expect(h.jobs).toHaveLength(5);
  h.cache.clear();
});

it.each(['invalidate', 'clear', 'dispose'] as const)(
  '%s rejects running and queued owners without publishing obsolete data or leaking permits',
  async (action) => {
    const h = fixture(),
      s = h.session();
    const create = vi.fn(() => 'blob:fixture');
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
    // Direct cache consumers queue at the actual-I/O boundary; session consumers
    // exercise its admission queue and dispose signal separately.
    const requests = Array.from({ length: 8 }, (_, i) =>
      action === 'dispose'
        ? h.cover(s, i, new AbortController()).catch((error) => error)
        : h.cache.resolve(key(i), h.load, new AbortController().signal).catch((error) => error),
    );
    if (action === 'invalidate') h.cache.invalidateSource('fixture.source');
    else if (action === 'clear') h.cache.clear();
    else s.dispose();
    const settled = await Promise.all(requests);
    expect(settled.every((result) => result instanceof DOMException && result.name === 'AbortError')).toBe(true);
    expect(h.jobs).toHaveLength(4);
    expect(h.jobs.every((job) => job.signal.aborted)).toBe(true);
    h.jobs.forEach((job) => job.finish());
    await vi.waitFor(() => expect(h.live()).toBe(0));
    expect(create).not.toHaveBeenCalled();
    const next = Array.from({ length: 4 }, (_, i) => h.cache.resolve(key(i), h.load, new AbortController().signal));
    await vi.waitFor(() => expect(h.jobs).toHaveLength(8));
    h.jobs.slice(4).forEach((job) => job.finish());
    await Promise.all(next);
    expect(h.maximum()).toBe(4);
    h.cache.clear();
    s.dispose();
  },
);
