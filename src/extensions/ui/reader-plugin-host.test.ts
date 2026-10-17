import { afterEach, expect, it, vi } from 'vitest';
import { setup, install, id } from './store-test-fixture';
import { ReaderPluginHost } from './reader-plugin-host';
import { UiPluginRuntime } from './runtime';
import type { RuntimeInstance } from './runtime-instance';
import type { SelectionCapture } from './runtime-commands';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.restoreAllMocks();
});
async function fixture() {
  const { store, peer } = setup();
  cleanup.push(() => peer.close());
  await install(store);
  const win = {
    isSecureContext: true,
    crypto,
    Blob,
    MessageChannel,
    location: new URL('https://reader.example/'),
  } as unknown as Window;
  const host = new ReaderPluginHost(store, { window: win, shellUrl: '/shell.html', deployment: 'self-host' });
  cleanup.push(() => host.dispose());
  await host.refresh();
  const entry = host.getSnapshot().entries[0];
  const leave = host.enterReader('book', 'revision');
  host.selectPanel(entry.tab.id);
  const instance = { stop: vi.fn(async () => {}), invoke: vi.fn(async () => {}), state: 'ready' };
  const start = vi.spyOn(UiPluginRuntime.prototype, 'start').mockResolvedValue(instance as unknown as RuntimeInstance);
  const mount = () =>
    host.mount(entry, {} as HTMLElement, { theme: 'light', locale: 'ko', panelId: entry.panelId }, () => {});
  const capture: SelectionCapture = {
    contextKey: host.getSnapshot().reader!.key,
    selection: {
      schemaVersion: 1,
      text: '공유를 선택한 문장',
      capturedAt: new Date().toISOString(),
      textSource: 'original',
      location: { schemaVersion: 1, bookId: 'book', documentRevision: 'revision', locator: 'opaque' },
    },
  };
  return { store, peer, host, entry, leave, instance, start, mount, capture };
}
it('serializes StrictMode-like setup/cleanup/setup without starting the discarded preparation', async () => {
  const f = await fixture();
  const first = f.mount();
  const closed = first.close();
  const next = f.mount();
  await expect(first.ready).rejects.toThrow('CONTEXT_STALE');
  await closed;
  await next.ready;
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.start.mock.calls[0][3]).toMatchObject({ expectedRevision: f.entry.revision });
  await next.close();
  expect(f.start.mock.calls[0][3]?.signal?.aborted).toBe(true);
});
it('shares only on explicit request, consumes a copied pending capture once, and permits another share in the same panel', async () => {
  const f = await fixture();
  const panel = f.mount(),
    instance = await panel.ready;
  await f.host.invokePending(panel, f.entry, instance);
  expect(f.instance.invoke).not.toHaveBeenCalled();
  f.host.share(f.entry, `${id}.capture`, f.capture);
  f.capture.selection.text = 'later mutation';
  await f.host.invokePending(panel, f.entry, instance);
  await f.host.invokePending(panel, f.entry, instance);
  expect(f.instance.invoke).toHaveBeenCalledExactlyOnceWith(
    `${id}.capture`,
    expect.objectContaining({ selection: expect.objectContaining({ text: '공유를 선택한 문장' }) }),
  );
  f.host.share(f.entry, `${id}.capture`, f.capture);
  await f.host.invokePending(panel, f.entry, instance);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.instance.invoke).toHaveBeenCalledTimes(2);
});
it.each(['book', 'close'] as const)('drops a queued share after %s and prevents replay on reopen', async (reason) => {
  const f = await fixture();
  f.host.share(f.entry, `${id}.capture`, f.capture);
  if (reason === 'book') {
    f.leave();
    f.host.enterReader('other', 'other-revision');
  } else {
    f.host.selectPanel(null);
    f.host.selectPanel(f.entry.tab.id);
  }
  const panel = f.mount(),
    instance = await panel.ready;
  await f.host.invokePending(panel, f.entry, instance);
  expect(f.instance.invoke).not.toHaveBeenCalled();
});
it('rejects a late activation from an old Reader generation and cancels its signal', async () => {
  const f = await fixture();
  let release!: (value: RuntimeInstance) => void;
  f.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const panel = f.mount();
  const result = expect(panel.ready).rejects.toThrow('CONTEXT_STALE');
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  f.leave();
  expect(f.start.mock.calls[0][3]?.signal?.aborted).toBe(true);
  release(f.instance as unknown as RuntimeInstance);
  await result;
  await panel.close();
  expect(f.instance.stop).toHaveBeenCalled();
});
it('hides revoked commands, rejects stale inventory and binds session open to its reviewed installation revision', async () => {
  const f = await fixture();
  await f.peer.revoke(id, f.entry.revision);
  await expect(f.store.openSession(id, f.entry.revision)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
  await f.host.refresh();
  expect(f.host.getSnapshot().entries).toEqual([]);
  expect(() => f.host.share(f.entry, `${id}.capture`, f.capture)).toThrow('PACKAGE_GENERATION_CHANGED');
});
it('keeps an open panel and its pending share when an unrelated plugin is installed', async () => {
  const f = await fixture();
  const panel = f.mount(),
    instance = await panel.ready;
  f.host.share(f.entry, `${id}.capture`, f.capture);
  const { uiManifestFixture } = await import('../../../packages/extension-contracts/ui-test-fixture');
  const { buildBrowserUiPackage } = await import('../packages/browser-ui-package');
  const manifest = uiManifestFixture();
  const other = JSON.parse(JSON.stringify(manifest).split(id).join('org.example.other'));
  await install(f.peer, await buildBrowserUiPackage({ manifest: other, source: '// not executed', license: 'MIT' }));
  await f.host.refresh();
  expect(f.host.getSnapshot().entries).toHaveLength(2);
  expect(f.host.getSnapshot().entries.find((e) => e.pluginId === id)).toBe(f.entry);
  await f.host.invokePending(panel, f.entry, instance);
  expect(f.instance.invoke).toHaveBeenCalledOnce();
  expect(f.instance.stop).not.toHaveBeenCalled();
});
