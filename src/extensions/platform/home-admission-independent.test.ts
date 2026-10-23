import { afterEach, expect, it, vi } from 'vitest';
import { approve, setup } from './store-test-fixture';
import { PluginService } from './plugin-service';
import type { Installation } from './store-model';

const control = vi.hoisted(() => ({
  live: new Set<string>(),
  starts: [] as string[],
  feeds: [] as string[],
  peak: 0,
  busyStops: [] as string[],
  holdDescribe: false,
  describe: new Map<string, () => void>(),
  pending: new Map<string, { resolve: () => void; reject: (error: Error) => void }>(),
}));
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: control.live.size, calls: control.pending.size }),
  ControllerVm: class {
    private id: string;
    private stopped = false;
    private busy = 0;
    constructor(
      _session: unknown,
      source: string,
      private options: { onStop: (reason: string) => void },
    ) {
      this.id = JSON.parse(source.match(/@boaa-plugin (\{.+\}) \*\//)![1]).id;
      control.starts.push(this.id);
      control.live.add(this.id);
      control.peak = Math.max(control.peak, control.live.size);
      if (control.live.size > 4) throw Error('MOCK_REAL_WORKER_LIMIT');
    }
    get idle() {
      return this.busy === 0;
    }
    async invoke(op: string, _input?: unknown, signal?: AbortSignal) {
      this.busy++;
      try {
        if (op === 'describe' && control.holdDescribe)
          await new Promise<void>((resolve) => control.describe.set(this.id, resolve));
        if (op !== 'homeFeed') return null;
        control.feeds.push(this.id);
        await new Promise<void>((resolve, reject) => {
          control.pending.set(this.id, { resolve, reject });
          signal?.addEventListener('abort', () => reject(Error('CANCELLED')), { once: true });
        });
        return { ok: true, value: { items: [{ id: this.id, title: 'Neutral fixture' }] } };
      } finally {
        this.busy--;
        if (op === 'homeFeed') control.pending.delete(this.id);
      }
    }
    stop(reason = 'STOPPED') {
      if (this.stopped) return;
      this.stopped = true;
      if (this.busy) control.busyStops.push(this.id);
      control.live.delete(this.id);
      control.describe.get(this.id)?.();
      control.describe.delete(this.id);
      control.pending.get(this.id)?.reject(Error('STOPPED'));
      this.options.onStop(reason);
    }
  },
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  control.live.clear();
  control.starts = [];
  control.feeds = [];
  control.peak = 0;
  control.busyStops = [];
  control.holdDescribe = false;
  control.describe.clear();
  control.pending.clear();
  vi.restoreAllMocks();
});
async function fixture(count: number) {
  const { store, peer } = setup();
  cleanup.push(
    () => peer.close(),
    () => store.close(),
  );
  const service = new PluginService(store, {
    worker: () => {
      throw Error('Mocked VM only');
    },
    wasmUrl: '/synthetic.wasm',
  });
  cleanup.push(() => service.close());
  const rows: Installation[] = [];
  for (let i = 0; i < count; i++) {
    const header = {
      id: `org.example.admission-${i}`,
      version: '1.0.0',
      apiVersion: 2,
      license: 'MIT',
      activation: ['onHome'],
      permissions: ['home.feed'],
      features: ['home.feed'],
      contributes: { homeSections: [{ id: 'popular', title: 'Neutral fixture' }] },
    };
    const review = await store.inspect(
      new Blob([`/* @boaa-plugin ${JSON.stringify(header)} */\n`]),
      'single-js',
      'fixture',
    );
    rows.push(await store.install(review, approve(review)));
  }
  return { store, service, rows };
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
async function busyFour(f: Awaited<ReturnType<typeof fixture>>) {
  const running = f.rows.slice(0, 4).map((row) => outcome(f.service.homeFeed(row.pluginId, 'popular')));
  await vi.waitFor(() => expect(control.pending.size).toBe(4));
  return running;
}
async function releaseAll(promises: ReturnType<typeof outcome>[], expected: number) {
  // Release only calls the service actually admitted; every guest feed must dispatch once.
  for (let i = 0; i < expected + 2; i++) {
    for (const pending of [...control.pending.values()]) pending.resolve();
    if (control.feeds.length === expected) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const pending of [...control.pending.values()]) pending.resolve();
  return Promise.all(promises);
}
it('admits eight simultaneous cold feeds with startup reservations under four real mock workers', async () => {
  const f = await fixture(8);
  const load = f.store.loadEntry.bind(f.store);
  let release!: () => void;
  const startup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loading = new Set<string>();
  vi.spyOn(f.store, 'loadEntry').mockImplementation(async (session) => {
    loading.add(session.fence.installationId);
    await startup;
    return load(session);
  });
  control.holdDescribe = true;
  const jobs = f.rows.map((row) => outcome(f.service.homeFeed(row.pluginId, 'popular')));
  await vi.waitFor(() => expect(loading.size).toBe(4));
  // All four reservations are waiting before ControllerVm construction, occupancy is zero.
  expect(control.live.size).toBe(0);
  release();
  await vi.waitFor(() => expect(control.describe.size).toBe(4));
  expect(control.peak).toBe(4);
  control.holdDescribe = false;
  for (const resolve of control.describe.values()) resolve();
  control.describe.clear();
  await vi.waitFor(() => expect(control.pending.size).toBe(4));
  const results = await releaseAll(jobs, 8);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(control.peak).toBe(4);
  expect(control.starts).toHaveLength(8);
  expect(new Set(control.feeds).size).toBe(8);
  expect(control.feeds).toHaveLength(8);
  expect(control.busyStops).toEqual([]);
});
it('leaves a fifth feed queued while all four controllers are busy, then dispatches it exactly once', async () => {
  const f = await fixture(5),
    running = await busyFour(f);
  const fifth = outcome(f.service.homeFeed(f.rows[4].pluginId, 'popular'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(control.starts).toHaveLength(4);
  expect(control.feeds).not.toContain(f.rows[4].pluginId);
  expect(control.busyStops).toEqual([]);
  expect((await releaseAll([...running, fifth], 5)).every((result) => result.ok)).toBe(true);
  expect(control.feeds.filter((id) => id === f.rows[4].pluginId)).toHaveLength(1);
  expect(control.busyStops).toEqual([]);
});
it.each(['cancelled', 'disabled', 'closed'] as const)(
  'never dispatches a %s waiter after capacity becomes free',
  async (kind) => {
    const f = await fixture(5),
      running = await busyFour(f),
      abort = new AbortController();
    const row = f.rows[4];
    const fifth = outcome(f.service.homeFeed(row.pluginId, 'popular', abort.signal));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(control.starts).not.toContain(row.pluginId);
    if (kind === 'cancelled') abort.abort();
    else if (kind === 'disabled') {
      await f.store.disable(row.pluginId, row.revision);
      await f.service.reconcile();
    } else await f.service.close();
    for (const pending of [...control.pending.values()]) pending.resolve();
    expect((await fifth).ok).toBe(false);
    await Promise.all(running);
    expect(control.starts).not.toContain(row.pluginId);
    expect(control.feeds).not.toContain(row.pluginId);
    expect(control.peak).toBe(4);
  },
);
