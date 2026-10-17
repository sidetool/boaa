import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOfflineTTSDownloads, type OfflineTTSDownloadsInput } from './useOfflineTTSDownloads';
import type { TTSDownloadJob } from '../../domain/types';
import type { IndexedDbTTSDownloadRepository } from '../../storage/tts-download-store';
const repository = vi.hoisted(() => ({
  interruptedRenderSpecHashes: vi.fn<IndexedDbTTSDownloadRepository['interruptedRenderSpecHashes']>(),
  recoverInterrupted: vi.fn<IndexedDbTTSDownloadRepository['recoverInterrupted']>(),
  latestForBookRevision: vi.fn<IndexedDbTTSDownloadRepository['latestForBookRevision']>(),
  listItems: vi.fn<IndexedDbTTSDownloadRepository['listItems']>(),
}));
vi.mock('../../storage/tts-download-store', () => ({
  IndexedDbTTSDownloadRepository: class {
    interruptedRenderSpecHashes = repository.interruptedRenderSpecHashes;
    recoverInterrupted = repository.recoverInterrupted;
    latestForBookRevision = repository.latestForBookRevision;
    listItems = repository.listItems;
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const job: TTSDownloadJob = {
  id: 'job',
  bookId: 'book',
  contentRevisionId: 'v1',
  scope: { kind: 'book' },
  state: 'planned',
  plannedItems: 0,
  readyItems: 0,
  failedItems: 0,
  byteSize: 0,
  updatedAt: 'now',
  policy: { network: 'any', charging: 'any', retryLimit: 3, retainUntil: 'space_needed' },
};
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  repository.interruptedRenderSpecHashes.mockResolvedValue([]);
  repository.recoverInterrupted.mockResolvedValue(0);
  repository.latestForBookRevision.mockResolvedValue(job);
  repository.listItems.mockResolvedValue([]);
});
async function harness() {
  const input: OfflineTTSDownloadsInput = {
    bookId: 'book',
    contentRevision: 'v1',
    runtime: {},
    accountKey: 'account-a',
    mobile: true,
    notify: vi.fn(),
    cache: {
      evidence: vi.fn(async () => []),
      status: vi.fn(async () => ({
        itemCount: 0,
        byteSize: 0,
        staleItemCount: 0,
        staleByteSize: 0,
        protectedStaleItemCount: 0,
        persistenceSupported: true,
      })),
      requestPersistence: vi.fn(async () => true),
      removeStaleForBook: vi.fn(async () => ({ removedItems: 0, removedBytes: 0, protectedItems: 0 })),
    },
  };
  let hook!: ReturnType<typeof useOfflineTTSDownloads>;
  function Harness({ value }: { value: typeof input }) {
    hook = useOfflineTTSDownloads(value);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness value={input} />);
  });
  await vi.waitFor(() => expect(hook.job).toEqual(job));
  return {
    input,
    get hook() {
      return hook;
    },
    update(value: typeof input) {
      act(() => renderer!.update(<Harness value={value} />));
    },
  };
}
it.each(['book', 'revision', 'account', 'runtime'])(
  'prevents delayed download snapshots from crossing %s ownership',
  async (change) => {
    const h = await harness();
    const stale = deferred<TTSDownloadJob | undefined>();
    repository.latestForBookRevision.mockReturnValueOnce(stale.promise);
    const pending = h.hook.refresh();
    await vi.waitFor(() => expect(repository.latestForBookRevision).toHaveBeenCalledTimes(2));
    repository.latestForBookRevision.mockResolvedValue(undefined);
    h.update({
      ...h.input,
      bookId: change === 'book' ? 'other' : 'book',
      contentRevision: change === 'revision' ? 'v2' : 'v1',
      accountKey: change === 'account' ? 'account-b' : h.input.accountKey,
      runtime: change === 'runtime' ? {} : h.input.runtime,
    });
    await act(async () => {
      stale.resolve(job);
      await pending;
    });
    expect(h.hook.job).toBeUndefined();
  },
);
it('keeps the newer refresh when an old refresh rejects', async () => {
  const h = await harness();
  const stale = deferred<TTSDownloadJob | undefined>();
  repository.latestForBookRevision.mockReturnValueOnce(stale.promise);
  const first = h.hook.refresh().catch(() => undefined);
  await vi.waitFor(() => expect(repository.latestForBookRevision).toHaveBeenCalledTimes(2));
  const newest = { ...job, id: 'new' };
  repository.latestForBookRevision.mockResolvedValueOnce(newest);
  await act(async () => {
    await h.hook.refresh();
  });
  await act(async () => {
    stale.reject(new Error('old'));
    await first;
  });
  expect(h.hook.job?.id).toBe('new');
});
it('deduplicates recovery for a session, including overlapping refresh requests', async () => {
  const pending = deferred<number>();
  repository.recoverInterrupted.mockReturnValueOnce(pending.promise);
  const creating = harness();
  await vi.waitFor(() => expect(repository.recoverInterrupted).toHaveBeenCalledOnce());
  pending.resolve(0);
  const h = await creating;
  await act(async () => {
    await Promise.all([h.hook.refresh(), h.hook.refresh()]);
  });
  expect(repository.recoverInterrupted).toHaveBeenCalledOnce();
});
it('does not toast or requery from a storage action after unmount, and ignores retained callbacks', async () => {
  const h = await harness();
  const persisted = deferred<boolean>();
  vi.mocked(h.input.cache.requestPersistence).mockReturnValueOnce(persisted.promise);
  const old = h.hook;
  const request = old.requestStorage();
  act(() => renderer!.unmount());
  renderer = undefined;
  const queries = repository.latestForBookRevision.mock.calls.length;
  persisted.resolve(true);
  await request;
  await old.refresh();
  await old.removeStaleAudio();
  expect(h.input.notify).not.toHaveBeenCalled();
  expect(repository.latestForBookRevision).toHaveBeenCalledTimes(queries);
  expect(h.input.cache.removeStaleForBook).not.toHaveBeenCalled();
});
