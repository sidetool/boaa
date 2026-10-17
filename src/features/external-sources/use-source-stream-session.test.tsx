import { act, create } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { useSourceStreamSession } from './use-source-stream-session';
import { deferred, episode, fixture, visit } from './source-command-test-fixtures';
async function harness() {
  const f = fixture();
  let current!: ReturnType<typeof useSourceStreamSession>;
  function Probe({ options = f.options }) {
    current = useSourceStreamSession({ options, open: true, items: () => [] });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    ...f,
    get current() {
      return current;
    },
    update: async (options = f.options) => {
      await act(async () => root.update(<Probe options={options} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
it('rejects a cache result from an ABA owner before starting network or publishing a stream', async () => {
  const h = await harness();
  const pending = deferred<undefined>();
  h.state.getCachePage.mockReturnValue(pending.promise);
  let task!: Promise<void>;
  await act(async () => {
    task = h.current.resumeSourceVisit(visit);
  });
  await h.update({ ...h.options, settingsScope: 'other' });
  await h.update();
  await act(async () => {
    pending.resolve(undefined);
    await task;
  });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  expect(h.current.streaming).toBeUndefined();
  expect(h.options.notify).not.toHaveBeenCalled();
  h.dispose();
});
it('rechecks account generation after a pending cache write and does not open its late result', async () => {
  const h = await harness();
  const pending = deferred<void>();
  h.state.saveCachePage.mockReturnValue(pending.promise);
  let task!: Promise<void>;
  await act(async () => {
    task = h.current.resumeSourceVisit(visit);
  });
  expect(h.state.saveCachePage).toHaveBeenCalledOnce();
  h.generation('two');
  await h.update({ ...h.options, hostContext: { brokers: { get: () => undefined } } });
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(h.current.streaming).toBeUndefined();
  expect(h.options.notify).toHaveBeenCalledOnce();
  h.dispose();
});
it('retained old-owner commands cannot replace the current stream or abort its navigation', async () => {
  const h = await harness();
  const old = h.current;
  await h.update({ ...h.options, settingsScope: 'other' });
  const navigation = h.current.startResume();
  act(() => {
    expect(old.beginStream(episode())).toBe(false);
    old.cancelResume();
    old.closeStream();
  });
  expect(navigation.signal.aborted).toBe(false);
  act(() => {
    expect(h.current.beginStream(episode())).toBe(true);
  });
  expect(h.current.streaming?.item.key.remoteId).toBe('one');
  h.dispose();
});
it('preserves disconnected source opening while guarding its owner and keeps one port across episodes', async () => {
  const h = await harness();
  h.offline();
  act(() => {
    expect(h.current.beginStream(episode())).toBe(true);
  });
  const port = h.current.streaming!.port;
  expect(await port.open('one', new AbortController().signal)).toEqual({ text: 'synthetic body' });
  act(() => {
    h.current.beginStream(episode('two'));
  });
  expect(h.current.streaming!.port).toBe(port);
  await h.update({ ...h.options, state: { ...h.options.state } });
  await expect(port.open('two', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.textPort.open).toHaveBeenCalledOnce();
  h.dispose();
});
it('cancels a deferred cache read on unmount without network or user notifications', async () => {
  const h = await harness();
  const pending = deferred<undefined>();
  h.state.getCachePage.mockReturnValue(pending.promise);
  let task!: Promise<void>;
  await act(async () => {
    task = h.current.resumeSourceVisit(visit);
  });
  h.dispose();
  await act(async () => {
    pending.resolve(undefined);
    await task;
  });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  expect(h.options.notify).not.toHaveBeenCalled();
});
