import { UiStoreError } from '../ui/store-model';
import { afterEach, expect, it, vi } from 'vitest';
import { ControllerVm, controllerResources } from './controller-vm';
import type { PluginSession } from './store-model';
const machines: ControllerVm[] = [];
afterEach(() => {
  for (const vm of machines.splice(0)) vm.stop();
  vi.useRealTimers();
  expect(controllerResources()).toEqual({ workers: 0, calls: 0 });
});
function fixture(broker = async () => null) {
  const session: PluginSession = {
    handle: 'opaque',
    role: 'controller',
    fence: {
      installationId: 'i',
      digest: 'd',
      scopeId: 's',
      windowSessionId: 'w',
      instanceId: crypto.randomUUID(),
      generation: 1,
    },
  };
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  const stop = vi.fn();
  const vm = new ControllerVm(session, '//source', {
    worker: () => port as unknown as Worker,
    wasmUrl: '/wasm',
    broker,
    onStop: stop,
  });
  machines.push(vm);
  return {
    vm,
    port,
    stop,
    emit: (value: object) => port.onmessage?.({ data: { fence: session.fence, ...value } } as MessageEvent),
  };
}
it('bounds queued calls before READY and releases reservations on abort/stop', async () => {
  const { vm } = fixture();
  const abort = new AbortController();
  const first = vm.invoke('describe', {}, abort.signal);
  const rejected = expect(first).rejects.toThrow('CANCELLED');
  const pending = Array.from({ length: 15 }, () => vm.invoke('event').catch((e) => e.message));
  expect(() => vm.invoke('event')).toThrow('QUEUE_LIMIT');
  expect(controllerResources().calls).toBe(16);
  abort.abort();
  await rejected;
  expect(controllerResources().calls).toBe(15);
  vm.stop();
  await Promise.all(pending);
});
it('limits simultaneous workers without allocating a fifth one', () => {
  for (let i = 0; i < 4; i++) fixture();
  expect(() => fixture()).toThrow('WORKER_LIMIT');
  expect(controllerResources().workers).toBe(4);
});
it('rejects a forged full fence and terminates before delivering a result', async () => {
  const { vm, emit, port } = fixture();
  const call = vm.invoke('describe');
  const rejected = expect(call).rejects.toThrow('CONTEXT_STALE');
  emit({ kind: 'ready', fence: {} });
  await rejected;
  expect(port.terminate).toHaveBeenCalledOnce();
});
it('preserves a healthy VM after an acknowledged job cancellation', async () => {
  const { vm, emit, port } = fixture();
  emit({ kind: 'ready' });
  const abort = new AbortController();
  const call = vm.invoke('command', {}, abort.signal);
  const rejected = expect(call).rejects.toThrow('CANCELLED');
  abort.abort();
  expect(port.postMessage.mock.lastCall?.[0].kind).toBe('cancel');
  emit({ kind: 'result', id: 1, text: '{"ok":false,"code":"CANCELLED"}' });
  await rejected;
  expect(port.terminate).not.toHaveBeenCalled();
  const next = vm.invoke('command');
  emit({ kind: 'result', id: 2, text: '{"ok":true,"value":7}' });
  expect(await next).toBe(7);
});
it('terminates an uncooperative cancellation and rejects its pending call', async () => {
  vi.useFakeTimers();
  const { vm, emit, port } = fixture();
  emit({ kind: 'ready' });
  const abort = new AbortController();
  const call = vm.invoke('command', {}, abort.signal);
  const rejected = expect(call).rejects.toThrow('CANCEL_TIMEOUT');
  abort.abort();
  await vi.advanceTimersByTimeAsync(501);
  await rejected;
  expect(port.terminate).toHaveBeenCalledOnce();
});
it('drops a late broker result after cancellation', async () => {
  let release!: () => void;
  const pending = new Promise<null>((r) => {
    release = () => r(null);
  });
  const { vm, emit, port } = fixture(() => pending);
  emit({ kind: 'ready' });
  const abort = new AbortController();
  const call = vm.invoke('command', {}, abort.signal);
  const rejected = expect(call).rejects.toThrow('CANCELLED');
  emit({ kind: 'rpc', id: 7, invocationId: 1, text: '{"method":"settings.get","input":{}}' });
  abort.abort();
  release();
  await Promise.resolve();
  emit({ kind: 'result', id: 1, text: '{"ok":false,"code":"CANCELLED"}' });
  await rejected;
  expect(port.postMessage.mock.calls.some(([m]) => m.kind === 'reply')).toBe(false);
});
it('rejects malformed success envelopes instead of returning undefined', async () => {
  const { vm, emit } = fixture();
  emit({ kind: 'ready' });
  const call = vm.invoke('describe');
  const rejected = expect(call).rejects.toThrow('INVALID_MESSAGE');
  emit({ kind: 'result', id: 1, text: '{"ok":true}' });
  await rejected;
});
it('releases the VM immediately if delivery of an invocation fails', async () => {
  const { vm, emit, port } = fixture();
  emit({ kind: 'ready' });
  port.postMessage.mockImplementationOnce(() => {
    throw Error('transport closed');
  });
  await expect(vm.invoke('command')).rejects.toThrow('WORKER_ERROR');
  expect(port.terminate).toHaveBeenCalledOnce();
  expect(controllerResources()).toEqual({ workers: 0, calls: 0 });
});
it('handles cancellation delivery failure without throwing from the abort listener', async () => {
  const { vm, emit, port } = fixture();
  emit({ kind: 'ready' });
  const abort = new AbortController();
  const pending = vm.invoke('command', {}, abort.signal);
  const rejected = expect(pending).rejects.toThrow('WORKER_ERROR');
  port.postMessage.mockImplementationOnce(() => {
    throw Error('transport closed');
  });
  abort.abort();
  await rejected;
  expect(port.terminate).toHaveBeenCalledOnce();
  expect(controllerResources()).toEqual({ workers: 0, calls: 0 });
});
it('terminates an automatic decoration that never completes after its shorter wall budget', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.emit({ kind: 'ready' });
  const result = expect(f.vm.invoke('decorate')).rejects.toThrow('WATCHDOG_TIMEOUT');
  await vi.advanceTimersByTimeAsync(5000);
  await result;
  expect(f.port.terminate).toHaveBeenCalledOnce();
});

it.each([
  ['ANNOTATION_CONFLICT', 'ANNOTATION_CONFLICT'],
  ['SECRET_DATABASE_DETAIL', 'HOST_REQUEST_DENIED'],
])('only exposes allowlisted annotation error %s', async (code, expected) => {
  const { vm, emit, port } = fixture(async () => {
    throw new UiStoreError(code);
  });
  emit({ kind: 'ready' });
  const call = vm.invoke('command');
  emit({
    kind: 'rpc',
    id: 7,
    invocationId: 1,
    text: JSON.stringify({ method: 'reader.annotations.update', input: {} }),
  });
  await vi.waitFor(() => expect(port.postMessage.mock.calls.some(([m]) => m.kind === 'reply')).toBe(true));
  const reply = port.postMessage.mock.calls.find(([m]) => m.kind === 'reply')![0];
  expect(JSON.parse(reply.text)).toEqual({ ok: false, code: expected });
  emit({ kind: 'result', id: 1, text: '{"ok":true,"value":null}' });
  await call;
});
