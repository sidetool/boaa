import { afterEach, it, expect, vi } from 'vitest';
import { setup, install, id, schema, single, approve } from './store-test-fixture';
import { PluginService } from './plugin-service';
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    stopped = false;
    constructor(
      _session: unknown,
      _source: unknown,
      private options: { onStop: (reason: string) => void },
    ) {}
    async invoke(op: string) {
      return op === 'describe' ? schema : null;
    }
    stop(reason = 'STOPPED') {
      if (this.stopped) return;
      this.stopped = true;
      this.options.onStop(reason);
    }
  },
}));
afterEach(() => vi.restoreAllMocks());
it.each(['initializing', 'settings'])(
  'treats revocation during %s as normal retirement, not a VM crash',
  async (phase) => {
    const { store, peer } = setup();
    const row = await install(store);
    const service = new PluginService(store, {
      worker: () => {
        throw Error('mock VM');
      },
      wasmUrl: '/wasm',
    });
    try {
      if (phase === 'settings') {
        await service.setReader(true);
        expect(await store.unfinishedMarkers()).toHaveLength(1);
      }
      const original = store.sessionPermissions.bind(store);
      vi.spyOn(store, 'sessionPermissions').mockImplementationOnce(async (session) => {
        await peer.disable(id, row.revision);
        return original(session);
      });
      if (phase === 'settings') await service.reconcile();
      else await service.setReader(true);
      await service.close();
      expect(await store.unfinishedMarkers()).toEqual([]);
      expect(service.status().faults).toEqual([]);
    } finally {
      await service.close();
      await store.close();
      await peer.close();
    }
  },
);

it('does not repeatedly restart code whose required setting permission was never granted', async () => {
  const { store, peer } = setup();
  const review = await store.inspect(single(), 'single-js', 'fixture');
  await store.install(review, approve(review, { roles: { controller: [] } }));
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock VM');
    },
    wasmUrl: '/wasm',
  });
  const open = vi.spyOn(store, 'openSession');
  try {
    await service.setReader(true);
    await service.reconcile();
    await service.reconcile();
    expect(open).toHaveBeenCalledTimes(1);
    expect(service.status().faults[0].code).toBe('START_FAILED');
  } finally {
    await service.close();
    await store.close();
    await peer.close();
  }
});
it('processes a fresh reconciliation request arriving after an older installation snapshot', async () => {
  const { store, peer } = setup();
  await install(store);
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock VM');
    },
    wasmUrl: '/wasm',
  });
  try {
    await service.setReader(true);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const list = store.list.bind(store);
    vi.spyOn(store, 'list').mockImplementationOnce(async () => {
      const rows = await list();
      entered();
      await hold;
      return rows;
    });
    const oldPass = service.reconcile();
    await started;
    const review = await peer.inspectRetained(id, 'active');
    const next = await peer.install(review, approve(review, { data: 'preserve', allowUnsignedDataReuse: true }));
    const freshPass = service.reconcile();
    release();
    await Promise.all([oldPass, freshPass]);
    expect(service.status().running[0]?.active).toBe(true);
    expect((await store.unfinishedMarkers()).some((marker) => marker.fence.generation === next.revision)).toBe(true);
  } finally {
    await service.close();
    await store.close();
    await peer.close();
  }
});
