import { afterEach, expect, it, vi } from 'vitest';
import { setup, composite, approve, id, schema } from './store-test-fixture';
import { PluginService } from './plugin-service';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    invoke = invoke;
    stop() {}
  },
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  invoke.mockReset();
});
async function fixture(active = true) {
  const { store, peer } = setup();
  cleanup.push(
    () => store.close(),
    () => peer.close(),
  );
  const review = await store.inspect(await composite(), 'package', 'fixture');
  const row = await store.install(review, approve(review));
  const ui = await store.openSession(id, 'ui', row.revision);
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock');
    },
    wasmUrl: '/wasm',
  });
  cleanup.push(() => service.close());
  invoke.mockImplementation(async (op: string) =>
    op === 'describe' ? schema : op === 'handler' ? { ok: true, value: 42 } : null,
  );
  if (active) await service.setReader(true);
  else await service.settings(id);
  return { store, peer, ui, service, row };
}
it('resolves the target from the real UI session and returns a bounded handler result', async () => {
  const f = await fixture();
  expect(await f.service.callFromView(f.ui, 'preview', { text: 'hi' }, new AbortController().signal)).toBe(42);
  expect(invoke).toHaveBeenCalledWith('handler', { id: 'preview', value: { text: 'hi' } }, expect.any(AbortSignal));
  expect(f.service.status().running[0].active).toBe(true);
});
it.each(['copy', 'foreign', 'controller', 'retired', 'generation', 'inactive', 'preabort'] as const)(
  'rejects %s without invoking guest handlers',
  async (mode) => {
    const f = await fixture(mode !== 'inactive');
    let caller = f.ui;
    const abort = new AbortController();
    if (mode === 'copy') caller = { ...f.ui };
    if (mode === 'foreign') caller = await f.peer.openSession(id, 'ui', f.row.revision);
    if (mode === 'controller') caller = await f.store.openSession(id, 'controller', f.row.revision);
    if (mode === 'retired') f.store.closeSession(caller);
    if (mode === 'generation') await f.peer.disable(id, f.row.revision);
    if (mode === 'preabort') abort.abort();
    invoke.mockClear();
    await expect(f.service.callFromView(caller, 'preview', null, abort.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  },
);
it('rejects stale replies after the UI session is closed and keeps the controller alive', async () => {
  const f = await fixture();
  invoke.mockImplementationOnce(async () => {
    f.store.closeSession(f.ui);
    return { ok: true, value: 42 };
  });
  await expect(f.service.callFromView(f.ui, 'preview', null, new AbortController().signal)).rejects.toThrow(
    'CONTEXT_STALE',
  );
  expect(f.service.status().running[0].active).toBe(true);
});
it('does not stop a controller for an unknown handler or a handled guest exception', async () => {
  const f = await fixture();
  for (const code of ['UNKNOWN_HANDLER', 'HANDLER_FAILED']) {
    invoke.mockResolvedValueOnce({ ok: false, code });
    await expect(f.service.callFromView(f.ui, 'preview', null, new AbortController().signal)).rejects.toThrow(code);
    expect(f.service.status().running[0].active).toBe(true);
  }
});
