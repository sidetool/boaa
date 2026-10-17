import 'fake-indexeddb/auto';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import type { ExternalItemPage } from '../../external-sources/contracts';
import { useSourceDownloadRecovery } from './use-source-download-recovery';
import type { SerialSourceItem } from './source-serial-item';

const item: SerialSourceItem = {
  key: { connectorId: 'fixture.source', accountConnectionId: 'account', remoteId: 'episode-1' },
  kind: 'file',
  title: 'Episode 1',
  importability: 'supported',
  importState: 'available',
  selected: false,
  collection: { remoteId: 'work', title: 'Work' },
  release: { title: 'Episode 1', chapterNumber: 1 },
};
afterEach(() => resetExternalSourceLocalStateForTests());

async function harness() {
  const state = new ExternalSourceLocalStateStore();
  let generation = '1';
  let abort: AbortController | undefined;
  const execute = vi.fn(async () => true);
  const notify = vi.fn();
  const list = vi.fn(async (): Promise<ExternalItemPage> => ({ items: [item] }));
  let control!: ReturnType<typeof useSourceDownloadRecovery>;
  function Probe() {
    control = useSourceDownloadRecovery({
      state,
      listNovels: async () => [],
      listChapters: async () => [],
      registry: {
        getExternalSourceStatus: () => ({
          state: 'connected',
          accountConnectionId: 'account',
          connectionGeneration: generation,
        }),
        listExternalSource: list,
      },
      hostContext: { brokers: { get: () => undefined } },
      notify,
      isMounted: () => true,
      isBusy: () => false,
      setImportBusy: () => {},
      setDownloadAbort: (value) => {
        abort = value;
      },
      importSerialItems: execute,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  const queue = (await control.persistDownloadIntent([item]))!;
  return {
    control,
    queue,
    state,
    execute,
    notify,
    list,
    changeGeneration: () => {
      generation = '2';
    },
    cancel: () => abort?.abort(),
    dispose: () => act(() => root.unmount()),
  };
}

it.each(['connection', 'cancel'] as const)(
  'retains queue intent when %s changes while fetching the recovery catalog',
  async (change) => {
    const h = await harness();
    let finish!: (page: ExternalItemPage) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      let pending!: Promise<void>;
      await act(async () => {
        pending = h.control.resumeDownloadQueue(h.queue);
      });
      await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
      expect(h.control.isRecovering()).toBe(true);
      if (change === 'connection') h.changeGeneration();
      else h.cancel();
      await act(async () => {
        finish({ items: [item] });
        await pending;
      });
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.control.isRecovering()).toBe(false);
      expect((await h.state.listDownloadQueues()).map((queue) => queue.id)).toEqual([h.queue.id]);
      expect(h.notify).toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it('rejects overlapping recovery and checkpoints only the active queue', async () => {
  const h = await harness();
  let finish!: () => void;
  h.execute.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      }),
  );
  try {
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.control.resumeDownloadQueue(h.queue);
    });
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledOnce());
    await h.control.resumeDownloadQueue(h.queue);
    expect(h.execute).toHaveBeenCalledTimes(1);
    await h.control.checkpointDownloadQueue([item]);
    expect(await h.state.listDownloadQueues()).toEqual([]);
    await act(async () => {
      finish();
      await pending;
    });
    expect(h.control.isRecovering()).toBe(false);
  } finally {
    h.dispose();
  }
});
