import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useSourceAutomaticDownload } from './use-source-automatic-download';
import { deferred, episode, fixture } from './source-command-test-fixtures';
async function harness(prepare?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  prepare?.(f);
  let accepting = true;
  const enqueue = vi.fn(async () => {});
  const queue = { canAccept: () => accepting, enqueue };
  let control!: ReturnType<typeof useSourceAutomaticDownload>;
  function Probe({ options = f.options }) {
    control = useSourceAutomaticDownload({ options, streamItem: episode(), busy: false, queue });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    ...f,
    enqueue,
    get current() {
      return control;
    },
    block() {
      accepting = false;
    },
    update: async (options = f.options) => {
      await act(async () => root.update(<Probe options={options} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
it('retires old-owner preparation while cache lookup is pending without starting its network request', async () => {
  const cache = deferred<undefined>();
  const h = await harness((f) => f.state.getCachePage.mockReturnValue(cache.promise));
  await h.update({
    ...h.options,
    settingsScope: 'new-owner',
    downloadPolicy: { ...h.options.downloadPolicy!, autoNext: false },
  });
  await act(async () => {
    cache.resolve(undefined);
    await cache.promise;
  });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(h.options.notify).not.toHaveBeenCalled();
  h.dispose();
});
it('does not enqueue after account generation changes during catalog cache persistence', async () => {
  const cache = deferred<void>();
  const h = await harness((f) => f.state.saveCachePage.mockReturnValue(cache.promise));
  expect(h.state.saveCachePage).toHaveBeenCalledOnce();
  h.generation('new');
  await act(async () => {
    cache.resolve();
    await cache.promise;
  });
  expect(h.enqueue).not.toHaveBeenCalled();
  h.dispose();
});
it('gives a manual batch priority if it acquires the queue while metadata is pending', async () => {
  const cache = deferred<void>();
  const h = await harness((f) => f.state.saveCachePage.mockReturnValue(cache.promise));
  h.block();
  await act(async () => {
    cache.resolve();
    await cache.promise;
  });
  expect(h.enqueue).not.toHaveBeenCalled();
  h.dispose();
});
it('checks account again after the stored chapter lookup before handing off the batch', async () => {
  const chapters = deferred<never[]>();
  const h = await harness((f) => {
    f.state.listLinks.mockResolvedValue([
      { source: episode().key, localBookId: 'book', collectionRemoteId: 'work' },
    ] as never[]);
    vi.mocked(f.options.listChapters).mockReturnValue(chapters.promise);
  });
  expect(h.options.listChapters).toHaveBeenCalledWith('book');
  h.generation('new');
  await act(async () => {
    chapters.resolve([]);
    await chapters.promise;
  });
  expect(h.enqueue).not.toHaveBeenCalled();
  h.dispose();
});
it('admits only the next release once and cancels pending preparation on unmount', async () => {
  const h = await harness();
  expect(h.enqueue).toHaveBeenCalledOnce();
  expect(h.enqueue.mock.calls[0]).toMatchObject([
    episode().key.connectorId,
    [expect.objectContaining({ key: episode('two').key })],
    expect.any(AbortSignal),
  ]);
  await h.update();
  expect(h.enqueue).toHaveBeenCalledOnce();
  h.dispose();
  const pending = deferred<undefined>();
  const closing = await harness((f) => f.state.getCachePage.mockReturnValue(pending.promise));
  closing.dispose();
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });
  expect(closing.registry.listExternalSource).not.toHaveBeenCalled();
  expect(closing.enqueue).not.toHaveBeenCalled();
});

it('does not start the captured account request after connection changes during a cache miss', async () => {
  const cache = deferred<undefined>();
  const h = await harness((f) => f.state.getCachePage.mockReturnValue(cache.promise));
  h.generation('new');
  await h.update({ ...h.options, hostContext: { brokers: { get: () => undefined } } });
  await act(async () => {
    cache.resolve(undefined);
    await cache.promise;
  });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
  h.dispose();
});

it('does not apply retained automatic-download preferences to a replacement owner', async () => {
  const updatePolicy = vi.fn();
  const h = await harness((f) => {
    Object.assign(f.options, { updateDownloadPolicy: updatePolicy });
  });
  const old = h.current;
  await h.update({
    ...h.options,
    settingsScope: 'new-owner',
    downloadPolicy: { ...h.options.downloadPolicy!, autoNext: false },
  });
  act(() => {
    old.setEnabled(false);
    old.setCount(3);
  });
  expect(updatePolicy).not.toHaveBeenCalled();
  h.dispose();
});
