import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setup, install, id } from './store-test-fixture';
import { RuntimeDispatcher } from './runtime-dispatcher';
import type { UiRequest, SharedSelection } from '@boaa/extension-contracts/ui-protocol';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
async function fixture() {
  const f = setup();
  cleanup.push(
    () => f.store.close(),
    () => f.peer.close(),
  );
  await install(f.store);
  const session = await f.store.openSession(id);
  const pkg = await f.store.loadSessionPackage(session);
  const messages: unknown[] = [];
  let phase = 'activating';
  let reader = { key: 'reader-1', bookId: 'book', documentRevision: 'rev-1' };
  const stop = vi.fn(() => {
    phase = 'stopped';
    dispatcher.close();
    f.store.closeSession(session);
  });
  const dispatcher = new RuntimeDispatcher(
    f.store,
    session,
    'session',
    pkg.manifest,
    () => phase,
    (v) => messages.push(v),
    stop,
    () => reader,
  );
  cleanup.push(() => dispatcher.close());
  let sequence = 0;
  const call = (method: UiRequest['method'], params: unknown, requestId = `r${++sequence}`) => {
    dispatcher.receive({ wireVersion: 1, kind: 'request', sessionId: 'session', requestId, method, params });
    return requestId;
  };
  return {
    ...f,
    session,
    dispatcher,
    messages,
    call,
    stop,
    ready: () => {
      phase = 'ready';
    },
    readerChange: () => {
      reader = { ...reader, key: 'reader-2' };
      dispatcher.commands.contextChanged();
    },
  };
}
const selection: SharedSelection = {
  schemaVersion: 1,
  text: 'Selected text',
  location: { schemaVersion: 1, bookId: 'book', documentRevision: 'rev-1', locator: 'paragraph:1' },
  capturedAt: '2026-10-02T00:00:00.000Z',
  textSource: 'original',
};
beforeEach(() => {
  selection.capturedAt = new Date().toISOString();
});
it('allows activation to await storage and command registration, but not selection', async () => {
  const f = await fixture();
  f.call('storage.set', { key: 'k', value: 'v', expectedRevision: null, idempotencyKey: 'write' });
  f.call('commands.register', { commandId: `${id}.capture`, handlerId: 'h1' });
  f.call('reader.consumeSelection', { token: 'not-shared' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(3));
  expect(f.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ok: true, requestId: 'r1' }),
      expect.objectContaining({ ok: true, requestId: 'r2' }),
      expect.objectContaining({ ok: false, error: { code: 'CONTEXT_STALE', retryable: false } }),
    ]),
  );
  expect(f.stop).not.toHaveBeenCalled();
});
it('rejects undeclared commands and consumes a snapshot once within its invocation', async () => {
  const f = await fixture();
  f.call('commands.register', { commandId: 'org.other.capture', handlerId: 'h0' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  f.call('commands.register', { commandId: `${id}.capture`, handlerId: 'h1' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  f.ready();
  const pending = f.dispatcher.commands.invoke(`${id}.capture`, { contextKey: 'reader-1', selection });
  await vi.waitFor(() => expect(f.messages).toHaveLength(3));
  const invoke = f.messages[2] as { selectionToken: string; requestId: string };
  f.call('reader.consumeSelection', { token: invoke.selectionToken });
  await vi.waitFor(() => expect(f.messages).toHaveLength(4));
  expect(f.messages[3]).toMatchObject({ ok: true, result: selection });
  f.call('reader.consumeSelection', { token: invoke.selectionToken });
  await vi.waitFor(() => expect(f.messages).toHaveLength(5));
  expect(f.messages[4]).toMatchObject({ ok: false, error: { code: 'CONTEXT_STALE' } });
  f.dispatcher.receive({
    wireVersion: 1,
    kind: 'invocationResult',
    sessionId: 'session',
    requestId: invoke.requestId,
    ok: true,
  });
  await pending;
});
it('invalidates captures on Reader context changes, even if book and revision names match', async () => {
  const f = await fixture();
  f.ready();
  f.call('commands.register', { commandId: `${id}.capture`, handlerId: 'h1' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  const invoke = f.dispatcher.commands.invoke(`${id}.capture`, { contextKey: 'reader-1', selection });
  const rejected = expect(invoke).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  f.readerChange();
  await rejected;
  await expect(
    f.dispatcher.commands.invoke(`${id}.capture`, { contextKey: 'reader-1', selection }),
  ).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it.each(['replay', 'session', 'unknown', 'concurrency'])('closes on %s wire abuse', async (kind) => {
  const f = await fixture();
  if (kind === 'replay') {
    f.call('storage.get', { key: 'k' }, 'r1');
    f.call('storage.get', { key: 'k' }, 'r1');
  }
  if (kind === 'session')
    f.dispatcher.receive({
      wireVersion: 1,
      kind: 'request',
      sessionId: 'forged',
      requestId: 'r1',
      method: 'storage.get',
      params: { key: 'k' },
    });
  if (kind === 'unknown')
    f.dispatcher.receive({
      wireVersion: 1,
      kind: 'request',
      sessionId: 'session',
      requestId: 'r1',
      method: 'native.secret',
      params: {},
    });
  if (kind === 'concurrency') for (let i = 0; i < 21; i++) f.call('storage.get', { key: 'k' });
  expect(f.stop).toHaveBeenCalled();
});
it('rechecks authority before posting a late read and never exposes the value after revoke', async () => {
  const f = await fixture();
  const original = f.store.storage.bind(f.store);
  let read!: () => void;
  const waiting = new Promise<void>((resolve) => {
    read = resolve;
  });
  vi.spyOn(f.store, 'storage').mockImplementation(async (...args) => {
    const result = await original(...args);
    await waiting;
    return result;
  });
  f.call('storage.get', { key: 'k' });
  await vi.waitFor(() => expect(f.store.storage).toHaveBeenCalled());
  await f.peer.revoke(id, 1);
  read();
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
  expect(f.messages).toEqual([]);
});
it('retiring a session immediately denies RPC but retains its marker until surface removal', async () => {
  const f = await fixture();
  await f.store.startMarker(f.session, 'tab', 'instance');
  const finish = f.store.retireSession(f.session, 'instance');
  await expect(f.store.assertSession(f.session)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
  expect(await f.store.unfinishedMarkers()).toHaveLength(1);
  await finish();
  expect(await f.store.unfinishedMarkers()).toHaveLength(0);
});
it('rechecks the active archive after session capture', async () => {
  const f = await fixture();
  await f.peer.revoke(id, 1);
  await expect(f.store.loadSessionPackage(f.session)).rejects.toMatchObject({ code: 'PACKAGE_GENERATION_CHANGED' });
});
it('drops a cancelled in-flight read and skips cancelled queued work', async () => {
  const f = await fixture();
  const original = f.store.storage.bind(f.store);
  const release: (() => void)[] = [];
  vi.spyOn(f.store, 'storage').mockImplementation(async (...args) => {
    await new Promise<void>((r) => release.push(r));
    return original(...args);
  });
  for (let i = 0; i < 5; i++) f.call('storage.get', { key: 'k' });
  await vi.waitFor(() => expect(release).toHaveLength(4));
  for (const requestId of ['r1', 'r5'])
    f.dispatcher.receive({ wireVersion: 1, kind: 'cancel', sessionId: 'session', requestId });
  for (const resolve of release) resolve();
  await vi.waitFor(() => expect(f.messages).toHaveLength(3));
  expect(f.store.storage).toHaveBeenCalledTimes(4);
  expect(f.messages).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: 'r1' }),
      expect.objectContaining({ requestId: 'r5' }),
    ]),
  );
});
it('bounds a stalled request and closes access after its deadline', async () => {
  const f = await fixture();
  vi.spyOn(f.store, 'storage').mockImplementation(() => new Promise(() => {}));
  f.call('storage.get', { key: 'k' });
  await vi.waitFor(() => expect(f.store.storage).toHaveBeenCalled());
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce(), { timeout: 4000 });
  await expect(f.store.assertSession(f.session)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
});
it('rate-limits control messages as well as data requests', async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++)
    f.dispatcher.receive({ wireVersion: 1, kind: 'cancel', sessionId: 'session', requestId: `r${i + 1}` });
  expect(f.stop).toHaveBeenCalledOnce();
});
it('cancelling a queued read removes its shorter deadline while active writes may finish', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const original = f.store.storage.bind(f.store);
  const release: (() => void)[] = [];
  vi.spyOn(f.store, 'storage').mockImplementation(async (...args) => {
    await new Promise<void>((r) => release.push(r));
    return original(...args);
  });
  for (let i = 0; i < 4; i++)
    f.call('storage.set', { key: `k${i}`, value: i, expectedRevision: null, idempotencyKey: `w${i}` });
  await vi.waitFor(() => expect(release).toHaveLength(4));
  const requestId = f.call('storage.get', { key: 'k0' });
  f.dispatcher.receive({ wireVersion: 1, kind: 'cancel', sessionId: 'session', requestId });
  await vi.advanceTimersByTimeAsync(3100);
  expect(f.stop).not.toHaveBeenCalled();
  for (const resolve of release) resolve();
  await vi.waitFor(() => expect(f.messages).toHaveLength(4));
  expect(f.store.storage).toHaveBeenCalledTimes(4);
});
it('shares the RPC budget with surface controls without dropping legitimate adjacent keys', async () => {
  const f = await fixture();
  expect(f.dispatcher.acceptControl()).toBe(true);
  expect(f.dispatcher.acceptControl()).toBe(true);
  for (let i = 0; i < 99; i++)
    f.dispatcher.receive({ wireVersion: 1, kind: 'cancel', sessionId: 'session', requestId: `r${i + 1}` });
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.dispatcher.acceptControl()).toBe(false);
});
