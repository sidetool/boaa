import type { ControllerOptions } from './controller-vm';
import { afterEach, it, expect, vi } from 'vitest';
import { setup, approve, schema } from './store-test-fixture';
import { PluginService } from './plugin-service';
import { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
const invoke = vi.hoisted(() => vi.fn());
const broker = vi.hoisted(() => ({ current: undefined as ControllerOptions['broker'] | undefined }));
vi.mock('./controller-vm', () => ({
  controllerResources: () => ({ workers: 0, calls: 0 }),
  ControllerVm: class {
    constructor(_session: unknown, _source: string, options: ControllerOptions) {
      broker.current = options.broker;
    }
    invoke = invoke;
    stop() {}
  },
}));
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  invoke.mockReset();
  vi.restoreAllMocks();
});
const header = {
  id: 'org.test.paint',
  version: '1.0.0',
  apiVersion: 2,
  license: 'MIT',
  activation: ['onReader'],
  permissions: ['reader.content.visible', 'reader.decorations'],
  features: ['reader.content.visible', 'reader.decorations'],
  contributes: { decorations: ['ink'] },
};
const output = {
  layers: [
    { id: 'ink', palette: { a: { color: '#123456' } }, ranges: [{ paragraphId: 'p', start: 0, end: 1, styleId: 'a' }] },
  ],
};
const content = {
  key: 'reader-a',
  bookId: 'book',
  chapterId: 'chapter',
  contentRevision: 'v1',
  theme: 'light',
  blocks: [{ id: 'p', text: 'abc', textHash: 'hash' }],
};
async function fixture(allowed = true, settings = false) {
  const { store, peer } = setup();
  closes.push(
    () => store.close(),
    () => peer.close(),
  );
  const review = await store.inspect(
    new Blob([
      `/* @boaa-plugin ${JSON.stringify(settings ? { ...header, permissions: [...header.permissions, 'settings.own'], features: [...header.features, 'settings.schema'] } : header)} */\n//mock`,
    ]),
    'single-js',
    'test',
  );
  const row = await store.install(
    review,
    approve(review, allowed ? {} : { roles: { controller: ['reader.decorations'] } }),
  );
  invoke.mockImplementation(async (op: string) =>
    op === 'describe' && settings ? schema : op === 'decorate' ? output : null,
  );
  const service = new PluginService(store, {
    worker: () => {
      throw Error('mock');
    },
    wasmUrl: '/wasm',
  });
  closes.push(() => service.close());
  const layers = new ReaderPluginDecorationLayers(() => {});
  const connection = service.connectReader(layers)!;
  connection.update(content);
  await service.reconcile();
  return { store, peer, row, service, layers, connection };
}
it('requires both actual grants before revealing canonical text to the controller', async () => {
  const f = await fixture(false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(invoke.mock.calls.some(([op]) => op === 'decorate')).toBe(false);
  expect(f.layers.getSnapshot('p')).toEqual([]);
  const session = await f.store.openSession(header.id, 'controller', f.row.revision);
  await expect(f.store.assertCall(session, session.fence, 'reader.decorations.changed')).rejects.toThrow(
    'PERMISSION_DENIED',
  );
});
it('rejects a compute reply if approval changes while author code runs', async () => {
  const f = await fixture();
  invoke.mockImplementation(async (op: string) => {
    if (op === 'decorate') {
      await f.peer.disable(header.id, f.row.revision);
      return output;
    }
    return null;
  });
  await vi.waitFor(() => expect(invoke.mock.calls.some(([op]) => op === 'decorate')).toBe(true));
  await vi.waitFor(() => expect(f.service.status().reader?.working).toBe(false));
  expect(f.layers.getSnapshot('p')).toEqual([]);
});
it('clears paint before service teardown and refuses new Reader attachments after close', async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.layers.getSnapshot('p')).toHaveLength(1));
  await f.service.close();
  expect(f.layers.getSnapshot('p')).toEqual([]);
  expect(() => f.service.connectReader(f.layers)).toThrow('SERVICE_CLOSED');
});
it('does not commit a result whose setting revision changed during computation', async () => {
  const f = await fixture(true, true);
  invoke.mockImplementation(async (op: string) => {
    if (op !== 'decorate') return null;
    const session = await f.peer.openSession(header.id, 'controller', f.row.revision);
    try {
      const config = (await f.peer.readConfig(session))!;
      await f.peer.writeConfig(session, {
        expectedRevision: config.revision,
        schema: config.schema,
        value: { ...config.value, color: '#abcdef' },
      });
    } finally {
      f.peer.closeSession(session);
    }
    return output;
  });
  await vi.waitFor(() => expect(f.service.status().reader?.errors[header.id]).toBe('CONFIG_CHANGED'));
  expect(f.layers.getSnapshot('p')).toEqual([]);
});
it('does not create a Reader binding with plugins off', async () => {
  const { store, peer } = setup();
  closes.push(
    () => store.close(),
    () => peer.close(),
  );
  const service = new PluginService(store, {
    off: true,
    worker: () => {
      throw Error('off');
    },
    wasmUrl: '/wasm',
  });
  closes.push(() => service.close());
  expect(service.connectReader(new ReaderPluginDecorationLayers(() => {}))).toBeUndefined();
  expect(service.status().reader).toBeUndefined();
});

it('does not expand visible-only approval into off-screen ordered content access', async () => {
  const f = await fixture();
  await expect(
    broker.current!('reader.decorations.changed', { ordered: ['ink'] }, new AbortController().signal),
  ).rejects.toThrow('PERMISSION_DENIED');
  await vi.waitFor(() => expect(f.layers.getSnapshot('p')).toHaveLength(1));
  expect(invoke.mock.calls.some(([op, input]) => op === 'decorate' && input.mode === 'ordered-chapter')).toBe(false);
});
