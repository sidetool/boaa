import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReaderPluginInput } from './ReaderPluginInput';
import { ReaderBindings } from './reader-binding';
import type { Installation } from './store-model';
import type { PluginService } from './plugin-service';
import type { PluginReaderAdapter } from './reader-session';
let renderer: ReactTestRenderer;
let listeners: Map<string, Set<(e: unknown) => void>>;
let selected: boolean;
let button: object;
let command: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;
const emit = (name: string, event: unknown = {}) =>
  act(() => {
    listeners.get(name)?.forEach((fn) => fn(event));
  });
const key = () => ({
  isTrusted: true,
  code: 'Space',
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  target: null,
  repeat: false,
  preventDefault() {},
  stopImmediatePropagation() {},
});
const pointer = (extra = {}) => ({
  isTrusted: true,
  pointerId: 1,
  button: 0,
  isPrimary: true,
  target: button,
  clientX: 0,
  clientY: 0,
  preventDefault() {},
  ...extra,
});
const tick = () =>
  act(() => {
    vi.advanceTimersByTime(500);
  });
beforeEach(() => {
  vi.useFakeTimers();
  selected = false;
  listeners = new Map();
  const target = {
    hidden: false,
    getSelection: () => ({ isCollapsed: !selected }),
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(fn);
    },
    removeEventListener: (name: string, fn: (e: unknown) => void) => {
      listeners.get(name)?.delete(fn);
    },
  };
  vi.stubGlobal('document', target);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('HTMLElement', class {});
  button = {
    setPointerCapture() {},
    hasPointerCapture() {
      return false;
    },
    releasePointerCapture() {},
  };
  const bindings = new ReaderBindings();
  bindings.select(
    {
      pluginId: 'p',
      revision: 1,
      active: 'd',
      installationId: 'i',
      enabled: true,
      manifest: { entries: { controller: { permissions: ['reader.input'] } }, contributes: { commands: ['hold'] } },
    } as unknown as Installation,
    'hold',
    'right',
  );
  command = vi.fn(async () => {});
  notify = vi.fn();
  const service = {
    bindings,
    boundReaderCommand: command,
    connectReaderActions: () => () => {},
  } as unknown as PluginService;
  const adapter = { contentRevision: 'r', state: () => ({}), start: () => undefined } as unknown as PluginReaderAdapter;
  act(() => {
    renderer = create(
      <ReaderPluginInput service={service} adapter={adapter} eligible generation="reader" onError={notify} />,
      { createNodeMock: () => button },
    );
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('does not cancel a keyboard hold for a collapsed caret notification but stops for an actual selection', () => {
  emit('keydown', key());
  emit('selectionchange');
  tick();
  expect(command).toHaveBeenCalledOnce();
  const signal = command.mock.calls[0][1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  selected = true;
  emit('selectionchange');
  expect(signal.aborted).toBe(true);
});
it('refuses untrusted input and preserves selection without invoking the plugin', () => {
  emit('pointerdown', pointer({ isTrusted: false }));
  tick();
  expect(command).not.toHaveBeenCalled();
  selected = true;
  emit('keydown', key());
  tick();
  expect(command).not.toHaveBeenCalled();
});
it('pointer release before the hold threshold and motion outside tolerance do not invoke code', () => {
  emit('pointerdown', pointer());
  emit('pointerup');
  tick();
  expect(command).not.toHaveBeenCalled();
  emit('pointerdown', pointer());
  emit('pointermove', pointer({ clientX: 20 }));
  tick();
  expect(command).not.toHaveBeenCalled();
});
it('an old async failure cannot cancel a newer hold or emit a misleading toast', async () => {
  let reject!: (e: Error) => void;
  command.mockImplementationOnce(
    () =>
      new Promise<void>((_, r) => {
        reject = r;
      }),
  );
  emit('keydown', key());
  tick();
  const old = command.mock.calls[0][1] as AbortSignal;
  emit('keyup');
  expect(old.aborted).toBe(true);
  emit('keydown', key());
  tick();
  const next = command.mock.calls[1][1] as AbortSignal;
  await act(async () => {
    reject(Error('late cancellation'));
    await Promise.resolve();
  });
  expect(next.aborted).toBe(false);
  expect(notify).not.toHaveBeenCalled();
  emit('keyup');
  expect(next.aborted).toBe(true);
});
