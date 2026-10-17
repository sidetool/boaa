import { afterEach, expect, it, vi } from 'vitest';
import { setup, approve, schema } from './store-test-fixture';
import { PluginService } from './plugin-service';
import { ReaderDecorationRuntime } from './reader-decoration-runtime';
import { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
import type { ControllerOptions } from './controller-vm';
const vm = vi.hoisted(() => ({ invoke: vi.fn(), broker: undefined as ControllerOptions['broker'] | undefined }));
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    constructor(_session: unknown, _source: unknown, options: ControllerOptions) {
      vm.broker = options.broker;
    }
    invoke = vm.invoke;
    stop() {}
  },
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vm.invoke.mockReset();
});
async function fixture() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const { store, peer } = setup();
  cleanups.push(
    () => store.close(),
    () => peer.close(),
  );
  const id = 'org.example.synthetic-poll';
  const metadata = {
    id,
    version: '1.0.0',
    apiVersion: 2,
    license: 'MIT',
    activation: ['onReader'],
    permissions: ['reader.content.visible', 'reader.decorations', 'settings.own'],
    features: ['reader.content.visible', 'reader.decorations', 'settings.schema'],
    contributes: { decorations: ['ink'] },
  };
  const review = await store.inspect(
    new Blob([`/* @boaa-plugin ${JSON.stringify(metadata)} */\n// synthetic host fixture`]),
    'single-js',
    'synthetic',
  );
  const row = await store.install(review, approve(review));
  vm.invoke.mockImplementation(async (op) => (op === 'describe' ? schema : op === 'decorate' ? { layers: [] } : null));
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock VM');
    },
    wasmUrl: '/synthetic.wasm',
  });
  cleanups.push(() => service.close());
  const layers = new ReaderPluginDecorationLayers(() => {});
  const connection = service.connectReader(layers)!;
  connection.update({
    key: 'reader',
    bookId: 'book',
    chapterId: 'chapter',
    contentRevision: 'one',
    theme: 'light',
    blocks: [{ id: 'p', text: 'Synthetic paragraph', textHash: 'hash' }],
  });
  await service.setReader(true);
  await vi.advanceTimersByTimeAsync(50);
  await vi.waitFor(() => expect(service.status().reader?.working).toBe(false));
  return { store, peer, service, row, id, layers, connection };
}
it('measures unchanged reconciliation without skipping installation, config or call authority reads', async () => {
  const f = await fixture();
  const list = vi.spyOn(f.store, 'list'),
    config = vi.spyOn(f.store, 'readConfig'),
    permissions = vi.spyOn(f.store, 'sessionPermissions'),
    calls = vi.spyOn(f.store, 'assertCall');
  const refresh = vi.spyOn(ReaderDecorationRuntime.prototype, 'refresh');
  vm.invoke.mockClear();
  const rounds = 40,
    start = performance.now();
  for (let i = 0; i < rounds; i++) await f.service.reconcile();
  const plans = refresh.mock.calls.flatMap(([plans]) => plans);
  console.log(
    JSON.stringify({
      case: 'synthetic-unchanged-plugin',
      rounds,
      listReads: list.mock.calls.length,
      configReads: config.mock.calls.length,
      permissionReads: permissions.mock.calls.length,
      callChecks: calls.mock.calls.length,
      paintRefreshes: refresh.mock.calls.length,
      distinctPlans: new Set(plans).size,
      guestInvocations: vm.invoke.mock.calls.length,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    }),
  );
  expect(list).toHaveBeenCalledTimes(rounds);
  expect(config).toHaveBeenCalledTimes(rounds * 2);
  expect(permissions).toHaveBeenCalledTimes(rounds * 2);
  expect(calls).toHaveBeenCalledTimes(rounds);
  expect(vm.invoke).not.toHaveBeenCalled();
  expect(new Set(plans).size).toBe(1);
});
it('observes cross-tab config and revoke on the next reconciliation', async () => {
  const f = await fixture();
  const refresh = vi.spyOn(ReaderDecorationRuntime.prototype, 'refresh');
  await f.service.reconcile();
  const prior = refresh.mock.calls.at(-1)![0][0];
  const session = await f.peer.openSession(f.id, 'controller', f.row.revision);
  const before = (await f.peer.readConfig(session))!;
  await f.peer.writeConfig(session, {
    schema,
    expectedRevision: before.revision,
    value: { ...before.value, enabled: false },
  });
  await f.service.reconcile();
  const next = refresh.mock.calls.at(-1)![0][0];
  expect(next.key).not.toBe(prior.key);
  expect(next.configRevision).toBe(before.revision + 1);
  expect(vm.invoke.mock.calls.filter(([op, input]) => op === 'event' && input.id === 'settings.changed')).toHaveLength(
    1,
  );
  await f.peer.disable(f.id, f.row.revision);
  await f.service.reconcile();
  expect(f.service.status().running).toEqual([]);
  expect(refresh.mock.calls.at(-1)![0]).toEqual([]);
});
it('keeps idle authority polling at 500 ms and revokes without a manual refresh', async () => {
  const f = await fixture();
  const original = f.store.assertSession.bind(f.store);
  const checks = vi.spyOn(f.store, 'assertSession');
  await f.peer.disable(f.id, f.row.revision);
  const stopped = new Promise<void>((resolve) => {
    checks.mockImplementation(async (...args) => {
      try {
        await original(...args);
      } finally {
        resolve();
      }
    });
  });
  await vi.advanceTimersByTimeAsync(500);
  await stopped;
  // The tick awaits assertSession before synchronously retiring the record.
  await Promise.resolve();
  await Promise.resolve();
  expect(f.service.status().running).toEqual([]);
  expect(checks).toHaveBeenCalled();
});

it('replaces cached plans on registration changes and rechecks a retained plan before invoking guest code', async () => {
  const f = await fixture();
  const refresh = vi.spyOn(ReaderDecorationRuntime.prototype, 'refresh');
  await f.service.reconcile();
  const first = refresh.mock.calls.at(-1)![0][0];
  await f.service.reconcile();
  expect(refresh.mock.calls.at(-1)![0][0]).toBe(first);
  await vm.broker!('reader.decorations.changed', {}, new AbortController().signal);
  await f.service.reconcile();
  const changed = refresh.mock.calls.at(-1)![0][0];
  expect(changed.key).not.toBe(first.key);
  await f.peer.disable(f.id, f.row.revision);
  vm.invoke.mockClear();
  await expect(
    changed.run(
      {
        key: 'reader',
        bookId: 'book',
        chapterId: 'chapter',
        contentRevision: 'one',
        theme: 'light',
        blocks: [{ id: 'p', text: 'Synthetic paragraph', textHash: 'hash' }],
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
  expect(vm.invoke).not.toHaveBeenCalled();
});
