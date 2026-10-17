import { afterEach, it, expect, vi } from 'vitest';
import { setup, composite, approve, id } from './store-test-fixture';
import { PluginTaskRuntime, taskResources } from './task-runtime';
import { RuntimeOwners } from './runtime-owners';
import { controllerResources } from './controller-vm';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  expect(taskResources().running).toBe(0);
  expect(controllerResources()).toEqual({ workers: 0, calls: 0 });
});
async function fixture() {
  const { store, peer } = setup();
  cleanup.push(
    () => store.close(),
    () => peer.close(),
  );
  const review = await store.inspect(await composite(), 'package', 'fixture');
  const row = await store.install(review, approve(review));
  const owner = await store.openSession(id, 'controller', row.revision);
  const owners = new RuntimeOwners();
  cleanup.push(async () => owners.close());
  const ports: {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[] = [];
  const runtime = new PluginTaskRuntime(store, owners, {
    wasmUrl: '/wasm',
    worker: () => {
      const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn(), terminate: vi.fn() };
      port.postMessage.mockImplementation((message) => {
        if (message.kind === 'init')
          queueMicrotask(() => port.onmessage?.({ data: { kind: 'ready', fence: message.fence } } as MessageEvent));
      });
      ports.push(port);
      return port as unknown as Worker;
    },
  });
  cleanup.push(() => runtime.close());
  return { store, owner, ports, runtime };
}
it('cancels a running task without retiring its owner and clears the task marker', async () => {
  const { store, owner, ports, runtime } = await fixture();
  const signal = new AbortController();
  const result = runtime.run(owner, {}, signal.signal);
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(ports[0]?.postMessage.mock.calls.some(([m]) => m.kind === 'invoke')).toBe(true));
  expect((await store.unfinishedMarkers()).map((m) => m.role)).toEqual(['task']);
  signal.abort();
  await rejected;
  expect(ports[0].terminate).toHaveBeenCalledOnce();
  expect(await store.unfinishedMarkers()).toEqual([]);
  await expect(store.assertSession(owner, owner.fence)).resolves.toBeUndefined();
});
it('reserves capacity before preparing code and cancels before allocating a Worker', async () => {
  const { store, owner, ports, runtime } = await fixture();
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>((r) => {
      entered = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  const original = store.loadEntry.bind(store);
  vi.spyOn(store, 'loadEntry').mockImplementation(async (session) => {
    const source = await original(session);
    entered();
    await hold;
    return source;
  });
  const abort = new AbortController();
  const result = runtime.run(owner, {}, abort.signal);
  const rejected = expect(result).rejects.toThrow('CANCELLED');
  await gate;
  await expect(runtime.run(owner, {}, new AbortController().signal)).rejects.toThrow('TASK_LIMIT');
  abort.abort();
  release();
  await rejected;
  expect(ports).toHaveLength(0);
  expect(await store.unfinishedMarkers()).toEqual([]);
  await expect(store.assertSession(owner, owner.fence)).resolves.toBeUndefined();
});
it('retains a faulty task marker and rejects a forged result without damaging owner authority', async () => {
  const { store, owner, ports, runtime } = await fixture();
  const result = runtime.run(owner, {}, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow('CONTEXT_STALE');
  await vi.waitFor(() => expect(ports[0]?.postMessage.mock.calls.some(([m]) => m.kind === 'invoke')).toBe(true));
  ports[0].onmessage?.({ data: { kind: 'result', fence: {}, id: 1, text: '{"ok":true,"value":123}' } } as MessageEvent);
  await rejected;
  expect((await store.unfinishedMarkers()).map((m) => m.role)).toEqual(['task']);
  await expect(store.assertSession(owner, owner.fence)).resolves.toBeUndefined();
  await expect(runtime.run(owner, {}, new AbortController().signal)).rejects.toThrow('RECOVERY_REQUIRED');
  expect(ports).toHaveLength(1);
});

it('does not execute prepared task bytes after its controller session is retired', async () => {
  const { store, owner, ports, runtime } = await fixture();
  const original = store.loadEntry.bind(store);
  vi.spyOn(store, 'loadEntry').mockImplementationOnce(async (session) => {
    const source = await original(session);
    store.closeSession(owner);
    return source;
  });
  await expect(runtime.run(owner, {}, new AbortController().signal)).rejects.toThrow('CONTEXT_STALE');
  expect(ports).toHaveLength(0);
  expect(await store.unfinishedMarkers()).toEqual([]);
});
