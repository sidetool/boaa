import { afterEach, expect, it, vi } from 'vitest';
import { setup, approve } from './store-test-fixture';
import { PluginService } from './plugin-service';
import type { PluginReaderAdapter } from './reader-session';
import type { ControllerOptions } from './controller-vm';
import type { PlatformPermission } from '@boaa/extension-contracts/platform-package';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
const control = vi.hoisted(() => ({ invoke: vi.fn(), options: undefined as ControllerOptions | undefined }));
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    constructor(_session: unknown, _source: unknown, options: ControllerOptions) {
      control.options = options;
    }
    invoke = control.invoke;
    stop() {}
  },
}));
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  control.invoke.mockReset();
});
const permissions = [
  'commands.register',
  'reader.input',
  'reader.control',
  'reader.state',
  'reader.content.book',
  'reader.annotations.read',
  'reader.annotations.write',
];
async function fixture(granted = permissions) {
  const { store, peer } = setup();
  closes.push(
    () => store.close(),
    () => peer.close(),
  );
  const header = {
    id: 'org.test.motion',
    version: '1.0.0',
    apiVersion: 2,
    license: 'MIT',
    activation: ['onCommand'],
    permissions,
    features: permissions,
    contributes: { commands: ['hold'] },
  };
  const review = await store.inspect(
    new Blob([`/* @boaa-plugin ${JSON.stringify(header)} */\n//mock`]),
    'single-js',
    'file',
  );
  const row = await store.install(review, approve(review, { roles: { controller: granted as PlatformPermission[] } }));
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock');
    },
    wasmUrl: '/wasm',
  });
  closes.push(() => service.close());
  let active = false;
  const stop = vi.fn(() => {
    active = false;
  });
  const adapter = {
    bookId: 'book',
    contentRevision: 'r',
    chapterId: 'ch',
    chapters: [],
    state: () => ({ bookId: 'book' }),
    start: vi.fn(() => {
      active = true;
      return { active: () => active, update: vi.fn(), stop };
    }),
  } as unknown as PluginReaderAdapter;
  const disconnect = service.connectReaderActions(adapter)!;
  service.bindings.select(row, 'hold', 'right');
  control.invoke.mockImplementation(async (op: string, value: UiJson) => {
    if (op === 'command') {
      const input = value as { value: { interactionId: string } };
      await control.options!.broker(
        'reader.auto.start',
        { interactionId: input.value.interactionId, speed: 6 },
        new AbortController().signal,
      );
    }
    return null;
  });
  return { store, peer, row, service, adapter, stop, disconnect };
}
it.each(['reader.input', 'reader.control'])(
  'requires the actual %s grant despite a host binding',
  async (permission) => {
    const f = await fixture(permissions.filter((p) => p !== permission));
    await expect(f.service.boundReaderCommand(f.service.bindings.get()!, new AbortController().signal)).rejects.toThrow(
      'PERMISSION_DENIED',
    );
    expect(f.adapter.start).not.toHaveBeenCalled();
  },
);
it('reader content and state have distinct grants and cannot be obtained through a generic command permission', async () => {
  const f = await fixture(['commands.register', 'reader.input']);
  const s = await f.store.openSession(f.row.pluginId, 'controller', f.row.revision);
  for (const method of ['reader.content.read', 'reader.content.search', 'reader.state.get'])
    await expect(f.store.assertCall(s, s.fence, method)).rejects.toThrow('PERMISSION_DENIED');
});
it.each(['released', 'reader-changed', 'binding-changed'])(
  'does not start a delayed controller after input becomes %s',
  async (reason) => {
    const f = await fixture(),
      abort = new AbortController();
    control.invoke.mockImplementation(async (op: string) => {
      if (op === 'describe') {
        if (reason === 'released') abort.abort();
        else if (reason === 'reader-changed') f.disconnect();
        else f.service.bindings.clear();
      }
      return null;
    });
    await expect(f.service.boundReaderCommand(f.service.bindings.get()!, abort.signal)).rejects.toThrow(
      'INPUT_EXPIRED',
    );
    expect(f.adapter.start).not.toHaveBeenCalled();
  },
);
it('stops active motion when another tab revokes the installation and does not carry binding across approval', async () => {
  const f = await fixture(),
    abort = new AbortController();
  await f.service.boundReaderCommand(f.service.bindings.get()!, abort.signal);
  expect(f.adapter.start).toHaveBeenCalledOnce();
  await f.peer.disable(f.row.pluginId, f.row.revision);
  await f.service.reconcile();
  expect(f.stop).toHaveBeenCalledOnce();
  if (f.service.bindings.get())
    await expect(f.service.boundReaderCommand(f.service.bindings.get()!, new AbortController().signal)).rejects.toThrow(
      'INPUT_EXPIRED',
    );
});

it('annotation methods require grants distinct from command registration', async () => {
  const f = await fixture(['commands.register']);
  const session = await f.store.openSession(f.row.pluginId, 'controller', f.row.revision);
  for (const method of [
    'reader.annotations.list',
    'reader.annotations.create',
    'reader.annotations.update',
    'reader.annotations.delete',
  ]) {
    await expect(f.store.assertCall(session, session.fence, method)).rejects.toThrow('PERMISSION_DENIED');
  }
});

it('read and write annotation grants are independent', async () => {
  const f = await fixture(['reader.annotations.read']);
  const s = await f.store.openSession(f.row.pluginId, 'controller', f.row.revision);
  await f.store.assertCall(s, s.fence, 'reader.annotations.list');
  await expect(f.store.assertCall(s, s.fence, 'reader.annotations.create')).rejects.toThrow('PERMISSION_DENIED');
});
