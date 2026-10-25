import 'fake-indexeddb/auto';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import type { Chapter, Novel } from '../../domain/types';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { externalItemSectionId } from './serial-work-projection';
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
  const listNovels = vi.fn(async (): Promise<Novel[]> => []);
  const listChapters = vi.fn(async (): Promise<Chapter[]> => []);
  const list = vi.fn(async (): Promise<ExternalItemPage> => ({ items: [item] }));
  let control!: ReturnType<typeof useSourceDownloadRecovery>;
  function Probe() {
    control = useSourceDownloadRecovery({
      state,
      listNovels,
      listChapters,
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
    listNovels,
    listChapters,
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

it('shares one catalog and chapter read per recovery pass while CAS pruning preserves concurrent revisions', async () => {
  const h = await harness();
  const second = {
    ...item,
    key: { ...item.key, remoteId: 'episode-2' },
    collection: { remoteId: 'other-work', title: 'Other' },
  };
  const queue = (await h.control.persistDownloadIntent([second]))!;
  for (const current of [item, second])
    await h.state.saveLink({
      id: current.key.remoteId,
      source: current.key,
      localBookId: 'book',
      collectionRemoteId: current.collection.remoteId,
      linkedAt: new Date().toISOString(),
    });
  h.listNovels.mockResolvedValue([testNovel({ id: 'book' })]);
  h.listChapters.mockResolvedValue(
    [item, second].map((current) => ({ id: externalItemSectionId(current) }) as Chapter),
  );
  const prune = h.state.pruneDownloadQueue.bind(h.state);
  vi.spyOn(h.state, 'pruneDownloadQueue').mockImplementationOnce(async (id, completed) => {
    const current = (await h.state.listDownloadQueues()).find((entry) => entry.id === id)!;
    await h.state.saveDownloadQueue({
      ...current,
      items: current.items.map((entry) => ({ ...entry, remoteRevision: 'new' })),
    });
    return prune(id, completed);
  });
  try {
    await act(async () => h.control.refreshRecovery(true));
    expect(h.listNovels).toHaveBeenCalledExactlyOnceWith({ includeTrash: true });
    expect(h.listChapters).toHaveBeenCalledExactlyOnceWith('book');
    const remaining = await h.state.listDownloadQueues();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].items[0].remoteRevision).toBe('new');
    expect([h.queue.id, queue.id]).toContain(remaining[0].id);
    // A later pass sees new imports/trash and must not reuse the previous snapshot.
    h.listNovels.mockResolvedValue([testNovel({ id: 'book', deletedAt: new Date().toISOString() })]);
    await act(async () => h.control.refreshRecovery(true));
    expect(h.listNovels).toHaveBeenCalledTimes(2);
    expect(await h.state.listDownloadQueues()).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it('does not prune from a superseded recovery pass after the latest snapshot moves the book to trash', async () => {
  const h = await harness();
  await h.state.saveLink({
    id: item.key.remoteId,
    source: item.key,
    localBookId: 'book',
    collectionRemoteId: item.collection.remoteId,
    linkedAt: new Date().toISOString(),
  });
  h.listNovels.mockResolvedValue([testNovel({ id: 'book' })]);
  let finish!: (chapters: Chapter[]) => void;
  h.listChapters.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const chapters = [{ id: externalItemSectionId(item) } as Chapter];
  let oldPass!: Promise<void>;
  try {
    await act(async () => {
      oldPass = h.control.refreshRecovery(true);
    });
    await vi.waitFor(() => expect(h.listChapters).toHaveBeenCalledOnce());
    h.listNovels.mockResolvedValue([testNovel({ id: 'book', deletedAt: new Date().toISOString() })]);
    h.listChapters.mockResolvedValue(chapters);
    await act(async () => h.control.refreshRecovery(true));
    await act(async () => {
      finish(chapters);
      await oldPass;
    });
    expect(await h.state.listDownloadQueues()).toEqual([h.queue]);
  } finally {
    finish?.(chapters);
    await oldPass;
    h.dispose();
  }
});
