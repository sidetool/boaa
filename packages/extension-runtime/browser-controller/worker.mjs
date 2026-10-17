import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { migrationBootstrap } from './migration-bootstrap.mjs';
import { taskBootstrap } from './task-bootstrap.mjs';
import { bootstrap } from './guest-bootstrap.mjs';
const MAX_BYTES = 65536;
let vm,
  runtime,
  dispatch,
  fence,
  stopped = false,
  initializing = false;
let deadline = Infinity,
  remaining = 500,
  current,
  rpcId = 0,
  calls = 0,
  pumpTimer;
const pending = new Map();
const bytes = (text) => new TextEncoder().encode(text).length;
function post(value) {
  self.postMessage({ ...value, fence });
}
function unwrap(result) {
  if (result.error) {
    result.error.dispose();
    throw Error('GUEST_FAILURE');
  }
  return result.value;
}
function fail(code) {
  if (stopped) return;
  stopped = true;
  clearTimeout(pumpTimer);
  post({ kind: 'failure', code });
  // Main thread revokes the broker and terminates the whole Worker; guest dispose isn't trusted.
}
function pump() {
  if (stopped || !current) return;
  clearTimeout(pumpTimer);
  if (remaining <= 0) {
    fail('TIMEOUT');
    return;
  }
  try {
    deadline = performance.now() + remaining;
    const before = performance.now();
    const jobs = runtime.executePendingJobs(16);
    remaining -= performance.now() - before;
    if (jobs.error) {
      jobs.error.dispose();
      throw Error('GUEST_FAILURE');
    }
    const state = vm.getPromiseState(current.promise);
    if (state.type === 'rejected') {
      state.error.dispose();
      throw Error('GUEST_FAILURE');
    }
    if (state.type === 'fulfilled') {
      if (vm.typeof(state.value) !== 'string') {
        state.value.dispose();
        throw Error('INVALID_RESULT');
      }
      const text = vm.getString(state.value);
      state.value.dispose();
      if (bytes(text) > MAX_BYTES) {
        fail('OUTPUT_LIMIT');
        return;
      }
      if (!runtime.hasPendingJob()) {
        if (pending.size) {
          fail('UNOWNED_ASYNC');
          return;
        }
        const usage = runtime.computeMemoryUsage();
        const memory = vm.dump(usage);
        usage.dispose();
        const id = current.id;
        current.promise.dispose();
        current = undefined;
        post({ kind: 'result', id, text, memoryBytes: memory.memory_used_size });
        return;
      }
    }
    pumpTimer = setTimeout(pump, runtime.hasPendingJob() ? 0 : 4);
  } catch {
    fail(performance.now() >= deadline ? 'TIMEOUT' : 'GUEST_FAILURE');
  }
}
async function initialize(message) {
  if (!['controller', 'task', 'migration'].includes(message.role)) throw Error('INVALID_ROLE');
  fence = message.fence;
  const engine = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmLocation: message.wasmUrl }));
  if (stopped) return;
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  vm = runtime.newContext();
  const rpc = vm.newFunction('rpc', (handle) => {
    if (!current || vm.typeof(handle) !== 'string' || pending.size >= 4 || ++calls > 32)
      return { error: vm.newError('RPC_LIMIT') };
    const text = vm.getString(handle);
    if (bytes(text) > MAX_BYTES) return { error: vm.newError('INPUT_LIMIT') };
    const id = ++rpcId,
      deferred = vm.newPromise();
    pending.set(id, { deferred, invocationId: current.id });
    post({ kind: 'rpc', id, invocationId: current.id, text });
    return deferred.handle;
  });
  deadline = performance.now() + 500;
  const factory = unwrap(
    vm.evalCode(
      message.role === 'migration' ? migrationBootstrap : message.role === 'task' ? taskBootstrap : bootstrap,
    ),
  );
  dispatch = unwrap(vm.callFunction(factory, vm.undefined, rpc));
  factory.dispose();
  rpc.dispose();
  deadline = performance.now() + 500;
  unwrap(vm.evalCode(message.source, message.role + '.js', { type: 'global' })).dispose();
  post({ kind: 'ready' });
}
self.onmessage = ({ data: m }) => {
  if (stopped) return;
  if (m.kind === 'init' && !initializing) {
    initializing = true;
    initialize(m).catch(() => fail(performance.now() >= deadline ? 'TIMEOUT' : 'INITIALIZATION_FAILED'));
    return;
  }
  if (!vm || JSON.stringify(m.fence) !== JSON.stringify(fence)) {
    fail('INVALID_MESSAGE');
    return;
  }
  if (m.kind === 'cancel') {
    if (!current || current.id !== m.id) return;
    try {
      deadline = performance.now() + remaining;
      const before = performance.now();
      const op = vm.newString('cancel'),
        input = vm.newString('{}');
      try {
        unwrap(vm.callFunction(dispatch, vm.undefined, op, input)).dispose();
      } finally {
        op.dispose();
        input.dispose();
      }
      for (const record of pending.values()) {
        const text = vm.newString('{"ok":false,"code":"CANCELLED"}');
        record.deferred.resolve(text);
        text.dispose();
        record.deferred.dispose();
      }
      pending.clear();
      remaining -= performance.now() - before;
      pump();
    } catch {
      fail('CANCEL_FAILED');
    }
    return;
  }
  if (m.kind === 'reply') {
    const record = pending.get(m.id);
    if (!record) return;
    if (record.invocationId !== current?.id || typeof m.text !== 'string' || bytes(m.text) > MAX_BYTES) {
      fail('INVALID_REPLY');
      return;
    }
    pending.delete(m.id);
    const text = vm.newString(m.text);
    record.deferred.resolve(text);
    text.dispose();
    record.deferred.dispose();
    pump();
    return;
  }
  if (m.kind !== 'invoke' || current || typeof m.text !== 'string' || bytes(m.text) > MAX_BYTES) {
    fail('INVALID_MESSAGE');
    return;
  }
  try {
    remaining = 500;
    deadline = performance.now() + remaining;
    const before = performance.now();
    calls = 0;
    const op = vm.newString(m.op),
      input = vm.newString(m.text);
    // Set invocation ownership before entering guest code, which can immediately call the broker.
    current = { id: m.id, promise: undefined };
    try {
      current.promise = unwrap(vm.callFunction(dispatch, vm.undefined, op, input));
    } finally {
      op.dispose();
      input.dispose();
      remaining -= performance.now() - before;
    }
    pump();
  } catch {
    fail(performance.now() >= deadline ? 'TIMEOUT' : 'GUEST_FAILURE');
  }
};
