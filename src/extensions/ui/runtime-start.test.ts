import { afterEach, expect, it, vi } from 'vitest';
import { UiPluginRuntime } from './runtime';
import { id, install, setup } from './store-test-fixture';
import type { UiPluginSession } from './plugin-store';
const cleanup: Array<() => Promise<void>> = [];
const releaseWaits: Array<() => void> = [];
afterEach(async () => {
  releaseWaits.splice(0).forEach((release) => release());
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseWaits.push(release);
  return { promise, release };
}
async function fixture() {
  const { store, peer } = setup();
  cleanup.push(async () => {
    await store.close();
    await peer.close();
  });
  await install(store);
  const document = { createElement: vi.fn(() => ({ setAttribute() {}, addEventListener() {}, remove: vi.fn() })) };
  const win = Object.assign(new EventTarget(), {
    document,
    crypto,
    Blob,
    MessageChannel,
    isSecureContext: true,
    location: new URL('https://boaa.example/'),
  }) as unknown as Window;
  const container = { ownerDocument: document, isConnected: true, append: vi.fn() } as unknown as HTMLElement;
  const runtime = new UiPluginRuntime(store, {
    window: win,
    deployment: 'self-host',
    shellUrl: '/shell.html',
    reader: () => null,
  });
  cleanup.push(() => runtime.dispose());
  const abort = new AbortController();
  const start = () =>
    runtime.start(id, container, { theme: 'light', locale: 'ko', panelId: `${id}.panel` }, { signal: abort.signal });
  return { store, runtime, document, container, abort, start };
}
it('rejects an already closed panel before reading the installation or creating a frame', async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.store, 'unfinishedMarkers');
  f.abort.abort();
  await expect(f.start()).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(lookup).not.toHaveBeenCalled();
  expect(f.document.createElement).not.toHaveBeenCalled();
});
it('revokes an opened session immediately when the panel closes during archive verification', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  let session!: UiPluginSession;
  const load = f.store.loadSessionPackage.bind(f.store);
  vi.spyOn(f.store, 'loadSessionPackage').mockImplementation(async (s) => {
    session = s;
    const pkg = await load(s);
    entered.release();
    await held.promise;
    return pkg;
  });
  const started = f.start();
  const rejected = expect(started).rejects.toMatchObject({ code: 'CANCELLED' });
  await entered.promise;
  f.abort.abort();
  await expect(f.store.assertSession(session)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  held.release();
  await rejected;
  expect(f.document.createElement).not.toHaveBeenCalled();
  expect(await f.store.unfinishedMarkers()).toEqual([]);
});
it('dispose waits for an in-flight session open and closes its late handle', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  let session!: UiPluginSession;
  const open = f.store.openSession.bind(f.store);
  vi.spyOn(f.store, 'openSession').mockImplementation(async (key) => {
    session = await open(key);
    entered.release();
    await held.promise;
    return session;
  });
  const rejected = expect(f.start()).rejects.toMatchObject({ code: 'CANCELLED' });
  await entered.promise;
  let done = false;
  const disposing = f.runtime.dispose().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  await expect(f.start()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  held.release();
  await rejected;
  await disposing;
  await expect(f.store.assertSession(session)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(f.document.createElement).not.toHaveBeenCalled();
});
it('closing during marker commit keeps the slot reserved until preparation settles, then permits reopening', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  const marker = f.store.startMarker.bind(f.store);
  vi.spyOn(f.store, 'startMarker').mockImplementationOnce(async (...args) => {
    await marker(...args);
    entered.release();
    await held.promise;
  });
  const rejected = expect(f.start()).rejects.toThrow();
  await entered.promise;
  expect(await f.store.unfinishedMarkers()).toHaveLength(1);
  f.abort.abort();
  await vi.waitFor(async () => expect(await f.store.unfinishedMarkers()).toEqual([]));
  // StrictMode's next setup must await its predecessor; it cannot overlap a cancelled start.
  await expect(
    f.runtime.start(id, f.container, { theme: 'light', locale: 'ko', panelId: `${id}.panel` }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  held.release();
  await rejected;
  expect(f.document.createElement).not.toHaveBeenCalled();
  const next = new AbortController();
  const nextResult = expect(
    f.runtime.start(id, f.container, { theme: 'light', locale: 'ko', panelId: `${id}.panel` }, { signal: next.signal }),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(f.container.append).toHaveBeenCalledOnce());
  next.abort();
  await nextResult;
  expect(await f.store.unfinishedMarkers()).toEqual([]);
});
it.each(['archive', 'marker'] as const)(
  'does not mount into a detached container after %s preparation',
  async (stage) => {
    const f = await fixture(),
      held = latch(),
      entered = latch();
    if (stage === 'archive') {
      const load = f.store.loadSessionPackage.bind(f.store);
      vi.spyOn(f.store, 'loadSessionPackage').mockImplementation(async (s) => {
        const pkg = await load(s);
        entered.release();
        await held.promise;
        return pkg;
      });
    } else {
      const marker = f.store.startMarker.bind(f.store);
      vi.spyOn(f.store, 'startMarker').mockImplementation(async (...args) => {
        await marker(...args);
        entered.release();
        await held.promise;
      });
    }
    const rejected = expect(f.start()).rejects.toThrow();
    await entered.promise;
    Object.assign(f.container, { isConnected: false });
    held.release();
    await rejected;
    expect(f.document.createElement).not.toHaveBeenCalled();
    expect(await f.store.unfinishedMarkers()).toEqual([]);
  },
);

it('drains all starts even if another panel fails marker cleanup during dispose', async () => {
  const f = await fixture(),
    held = latch(),
    entered = latch();
  const first = expect(f.start()).rejects.toThrow();
  await vi.waitFor(() => expect(f.container.append).toHaveBeenCalledOnce());
  // Hold a second preparation at the DB boundary; it never reaches archive loading.
  const open = f.store.openSession.bind(f.store);
  vi.spyOn(f.store, 'openSession').mockImplementationOnce(async () => {
    const session = await open(id);
    entered.release();
    await held.promise;
    return session;
  });
  const second = expect(
    f.runtime.start('org.example.pending', f.container, { theme: 'light', locale: 'ko', panelId: `${id}.panel` }),
  ).rejects.toThrow();
  await entered.promise;
  const retire = f.store.retireSession.bind(f.store);
  vi.spyOn(f.store, 'retireSession').mockImplementationOnce((session, instanceId) => {
    retire(session, instanceId); // Revoke immediately, but simulate failure to delete the owned marker.
    return async () => {
      throw new Error('fixture storage unavailable');
    };
  });
  let settled = false;
  const disposing = f.runtime.dispose().then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await first;
  // Flush continuations, without allowing the second DB result to settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  held.release();
  await second;
  expect(await disposing).toMatchObject({ message: 'fixture storage unavailable' });
  expect(await f.store.unfinishedMarkers()).toHaveLength(1);
});
