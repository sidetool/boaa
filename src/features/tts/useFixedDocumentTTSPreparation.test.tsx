import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useFixedDocumentTTSPreparation,
  type FixedDocumentTTSPreparationInput,
} from './useFixedDocumentTTSPreparation';
import { useTTSExecutionController } from './useTTSExecutionController';
import type { planFixedDocumentTTS, runFixedDocumentTTSDownload } from './fixed-document-tts-download';
import type { TTSDownloadJob } from '../../domain/types';
const mocks = vi.hoisted(() => ({
  plan: vi.fn<typeof planFixedDocumentTTS>(),
  run: vi.fn<typeof runFixedDocumentTTSDownload>(),
  create: vi.fn(),
  cancel: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
}));
vi.mock('./fixed-document-tts-download', () => ({
  planFixedDocumentTTS: mocks.plan,
  runFixedDocumentTTSDownload: mocks.run,
}));
vi.mock('../../storage/tts-download-store', () => ({
  IndexedDbTTSDownloadRepository: class {
    create = mocks.create;
    cancel = mocks.cancel;
    finish = mocks.finish;
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
const plan = { requests: [], sources: [], chapters: [], chapterIds: ['page-1'] };
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.plan.mockResolvedValue(plan);
  mocks.run.mockResolvedValue();
  mocks.create.mockResolvedValue(job);
});
function harness() {
  let hook!: ReturnType<typeof useFixedDocumentTTSPreparation>,
    execution!: ReturnType<typeof useTTSExecutionController>;
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  const input: Omit<FixedDocumentTTSPreparationInput, 'execution'> = {
    owner: {},
    ready: true,
    chapterId: 'fixed_document_book',
    plan: {
      novel: { id: 'book' },
      repository: { listReadyRevisions: vi.fn(), getBlocks: vi.fn() },
      voices: { chapters: [], voiceProfiles: [], contentRevision: 'v1' },
      speech: { rate: 1 },
    },
    backend: { native: false },
    policy: { network: 'any', charging: 'any' },
    prepareHosted: vi.fn(async () => true),
    refreshDownloads: vi.fn(async () => {}),
    notify: vi.fn(),
  };
  function Harness({ value, open }: { value: typeof input; open?: boolean }) {
    execution = useTTSExecutionController({
      systemTTS,
      bookId: value.plan?.novel.id,
      chapterId: value.chapterId,
      sessionOwner: value.owner,
    });
    hook = useFixedDocumentTTSPreparation({ ...value, execution });
    return open ? <div /> : null;
  }
  act(() => {
    renderer = create(<Harness value={input} open />);
  });
  return {
    input,
    get hook() {
      return hook;
    },
    get execution() {
      return execution;
    },
    update(value: typeof input) {
      act(() => renderer!.update(<Harness value={value} />));
    },
  };
}
it('owns the synthetic document lane before source reads and honors cancellation before persistence', async () => {
  const h = harness(),
    pending = deferred<typeof plan>();
  mocks.plan.mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.prepare(0, 2);
  });
  await vi.waitFor(() => expect(mocks.plan).toHaveBeenCalledOnce());
  expect(h.execution.warmupBusy).toBe(true);
  act(() => h.execution.cancelWarmup());
  await act(async () => {
    pending.resolve(plan);
    await task;
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(h.input.prepareHosted).not.toHaveBeenCalled();
  expect(h.input.refreshDownloads).toHaveBeenCalledOnce();
});
it.each(['revision', 'owner', 'book', 'unmount'])(
  'fences %s replacement while a persisted native/hosted job is pending',
  async (kind) => {
    const h = harness(),
      pending = deferred<void>();
    mocks.run.mockReturnValueOnce(pending.promise);
    let task!: Promise<void>;
    act(() => {
      task = h.hook.prepare(0, 2);
    });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    const lease = mocks.run.mock.calls[0][3];
    if (kind === 'unmount') {
      act(() => renderer!.unmount());
      renderer = undefined;
    } else
      h.update({
        ...h.input,
        owner: kind === 'owner' ? {} : h.input.owner,
        plan: {
          ...h.input.plan!,
          novel: { id: kind === 'book' ? 'other' : 'book' },
          voices: { ...h.input.plan!.voices, contentRevision: kind === 'revision' ? 'v2' : 'v1' },
        },
      });
    expect(lease.current()).toBe(false);
    expect(lease.operation.controller.signal.aborted).toBe(true);
    lease.notify('old', 'success');
    await act(async () => {
      pending.resolve();
      await task;
    });
    expect(h.input.notify).not.toHaveBeenCalled();
    expect(h.input.refreshDownloads).not.toHaveBeenCalled();
  },
);
it('preserves panel-close lifetime and blocks duplicate admission', async () => {
  const h = harness(),
    pending = deferred<void>();
  mocks.run.mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.prepare(0, 2);
  });
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  h.update(h.input);
  await h.hook.prepare(0, 2);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(h.execution.warmupBusy).toBe(true);
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(h.input.refreshDownloads).toHaveBeenCalledOnce();
});
it('cancels a job whose create resolved after replacement without running or refreshing', async () => {
  const h = harness(),
    pending = deferred<TTSDownloadJob>();
  mocks.create.mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.prepare(0, 2);
  });
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  h.update({ ...h.input, owner: {} });
  await act(async () => {
    pending.resolve(job);
    await task;
  });
  expect(mocks.cancel).toHaveBeenCalledWith('job');
  expect(mocks.run).not.toHaveBeenCalled();
  expect(h.input.refreshDownloads).not.toHaveBeenCalled();
});
it('refreshes persisted cancellation for the current owner', async () => {
  const h = harness(),
    pending = deferred<void>();
  mocks.run.mockImplementationOnce(async (...args) => {
    await pending.promise;
    args[3].operation.controller.signal.throwIfAborted();
  });
  let task!: Promise<void>;
  act(() => {
    task = h.hook.prepare(0, 2);
  });
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  act(() => h.execution.cancelWarmup());
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(mocks.cancel).toHaveBeenCalledWith('job');
  expect(h.input.refreshDownloads).toHaveBeenCalledOnce();
  expect(h.input.notify).not.toHaveBeenCalled();
});
