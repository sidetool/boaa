import { afterEach, expect, it, vi } from 'vitest';
import { setup, approve } from './store-test-fixture';
import { PluginService } from './plugin-service';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
const control = vi.hoisted(() => ({
  calls: [] as string[],
  feed: { items: [{ id: 'one', title: 'Example', rank: 1 }] } as UiJson,
}));
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    constructor(
      _session: unknown,
      private source: string,
    ) {}
    get idle() {
      return true;
    }
    async invoke(op: string, input?: { id?: string }) {
      if (op === 'event' && input?.id === 'app.ready') {
        control.calls.push(this.source.includes('broken') ? 'broken' : 'healthy');
        if (this.source.includes('broken')) throw Error('GUEST_FAILURE');
      }
      return op === 'homeFeed' ? { ok: true, value: control.feed } : null;
    }
    stop() {}
  },
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  control.calls = [];
});
async function fixture() {
  const { store } = setup();
  cleanup.push(() => store.close());
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock');
    },
    wasmUrl: '/synthetic.wasm',
  });
  cleanup.push(() => service.close());
  async function install(id: string, home: boolean) {
    const header = {
      id,
      name: id,
      version: '1.0.0',
      apiVersion: 2,
      license: 'MIT',
      activation: home ? ['onHome'] : ['onAppSession'],
      permissions: home ? ['home.feed'] : [],
      features: home ? ['home.feed'] : [],
      contributes: home ? { homeSections: [{ id: 'popular', title: 'Popular' }] } : {},
    };
    const review = await store.inspect(
      new Blob([`/* @boaa-plugin ${JSON.stringify(header)} */\n// ${id}`]),
      'single-js',
      'fixture',
    );
    return store.install(review, approve(review));
  }
  return { store, service, install };
}
it('isolates a failed app.ready event and starts the remaining plugins', async () => {
  const f = await fixture();
  await f.install('org.example.a-broken', false);
  await f.install('org.example.b-healthy', false);
  await expect(f.service.startSession()).resolves.toBeUndefined();
  expect(control.calls).toEqual(['broken', 'healthy']);
  expect(f.service.status().running.map((r) => r.id)).toEqual(['org.example.b-healthy']);
});
it('discovers enabled sections without activating controllers, then validates a requested feed', async () => {
  const f = await fixture(),
    row = await f.install('org.example.feed', true);
  await f.service.startSession();
  expect(f.service.status().running).toHaveLength(0);
  expect(await f.service.homeSections()).toEqual([
    expect.objectContaining({ pluginId: row.pluginId, section: { id: 'popular', title: 'Popular' } }),
  ]);
  control.feed = { items: [{ id: 'one', title: 'Example', rank: 1 }], ttlSeconds: 300 };
  expect(await f.service.homeFeed(row.pluginId, 'popular')).toEqual(control.feed);
  control.feed = { items: [{ id: 'one', title: 'Example', coverUrl: 'javascript:alert(1)' }] };
  await expect(f.service.homeFeed(row.pluginId, 'popular')).rejects.toThrow('INVALID_HOME_FEED');
  await f.store.disable(row.pluginId, row.revision);
  await f.service.reconcile();
  expect(await f.service.homeSections()).toEqual([]);
  await expect(f.service.homeFeed(row.pluginId, 'popular')).rejects.toThrow();
});
