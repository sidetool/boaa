import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTTSWarmupController, type TTSWarmupControllerInput } from './useTTSWarmupController';
import { useTTSExecutionController } from './useTTSExecutionController';
import type { TTSWarmupDownload, TTSWarmupExecution } from './tts-warmup-execution';
import type { TTSDownloadJob } from '../../domain/types';
import type { runHostedTTSDownload } from './hosted-tts-download';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  cancel: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  hosted: vi.fn<typeof runHostedTTSDownload>(),
}));
vi.mock('../../storage/tts-download-store', () => ({
  IndexedDbTTSDownloadRepository: class {
    create = mocks.create;
    cancel = mocks.cancel;
    finish = mocks.finish;
  },
}));
vi.mock('./hosted-tts-download', () => ({ runHostedTTSDownload: mocks.hosted }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
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
  mocks.create.mockResolvedValue(job);
  mocks.hosted.mockResolvedValue(false);
});
function harness() {
  let hook!: ReturnType<typeof useTTSWarmupController>;
  let execution!: ReturnType<typeof useTTSExecutionController>;
  const chapter = {
    id: 'chapter',
    novelId: 'book',
    title: '',
    index: 0,
    normalizedText: '',
    textHash: '',
    rawStartOffset: 0,
    rawEndOffset: 0,
    characterCount: 0,
    paragraphCount: 0,
    createdAt: '',
    updatedAt: '',
  };
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  const input: Omit<TTSWarmupControllerInput, 'execution'> = {
    owner: {},
    novel: { id: 'book', activeContentRevisionId: 'v1' },
    currentChapter: chapter,
    chapters: [chapter],
    ready: true,
    wholeBookReady: true,
    native: false,
    loadNativeContext: async () => {
      throw new Error('unused');
    },
    transport: {
      client: {
        resolveTTSCache: async () => {
          throw new Error('unused');
        },
        fetchTTSCacheAudio: async () => new Blob(),
      },
      cache: {
        getByCacheKey: async () => undefined,
        put: async () => {
          throw new Error('unused');
        },
      },
    },
    voices: { characters: [], voiceProfiles: [], baseRate: 1 },
    source: {
      repository: { getParagraph: async () => undefined, listSegments: async () => [] },
      currentSegments: [],
      loadVoiceBindings: async () => [],
    },
    policy: { network: 'any', charging: 'any' },
    prepareHosted: vi.fn(async () => true),
    refreshDownloads: vi.fn(async () => {}),
    notify: vi.fn(),
  };
  function Harness({ value, panelOpen }: { value: typeof input; panelOpen?: boolean }) {
    execution = useTTSExecutionController({
      systemTTS,
      bookId: value.novel?.id,
      chapterId: value.currentChapter?.id,
      sessionOwner: value.owner,
    });
    hook = useTTSWarmupController({ ...value, execution });
    return panelOpen ? <div>panel</div> : null;
  }
  act(() => {
    renderer = create(<Harness value={input} panelOpen />);
  });
  return {
    input,
    get hook() {
      return hook;
    },
    get execution() {
      return execution;
    },
    update(value: typeof input, panelOpen = false) {
      act(() => renderer!.update(<Harness value={value} panelOpen={panelOpen} />));
    },
  };
}
it('keeps preparation running when a panel closes and prevents duplicate admission', async () => {
  const h = harness();
  const pending = deferred<boolean>();
  mocks.hosted.mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.warmup('book');
  });
  await vi.waitFor(() => expect(mocks.hosted).toHaveBeenCalledOnce());
  h.update(h.input);
  await h.hook.warmup('book');
  expect(mocks.hosted).toHaveBeenCalledOnce();
  expect(h.execution.warmupBusy).toBe(true);
  await act(async () => {
    pending.resolve(false);
    await task;
  });
  expect(h.input.refreshDownloads).toHaveBeenCalledOnce();
  expect(h.execution.warmupBusy).toBe(false);
});
it.each(['revision', 'account/runtime', 'book', 'unmount'])(
  'revokes %s scope and persists cancellation without stale progress, toast or reload',
  async (kind) => {
    const h = harness();
    const pending = deferred<boolean>();
    mocks.hosted.mockReturnValueOnce(pending.promise);
    let task!: Promise<void>;
    act(() => {
      task = h.hook.warmup('book');
    });
    await vi.waitFor(() => expect(mocks.hosted).toHaveBeenCalledOnce());
    const lease: TTSWarmupExecution = mocks.hosted.mock.calls[0][6];
    if (kind === 'unmount') {
      act(() => renderer!.unmount());
      renderer = undefined;
    } else
      h.update({
        ...h.input,
        owner: {},
        novel: { id: kind === 'book' ? 'other' : 'book', activeContentRevisionId: kind === 'revision' ? 'v2' : 'v1' },
      });
    expect(lease.operation.controller.signal.aborted).toBe(true);
    expect(lease.current()).toBe(false);
    lease.notify('stale', 'success');
    await act(async () => {
      pending.reject(new DOMException('cancelled', 'AbortError'));
      await task;
    });
    expect(mocks.cancel).toHaveBeenCalledWith('job');
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(h.input.notify).not.toHaveBeenCalled();
    expect(h.input.refreshDownloads).not.toHaveBeenCalled();
  },
);
it('cancels a persisted job created after scope replacement without starting synthesis', async () => {
  const h = harness();
  const pending = deferred<TTSDownloadJob>();
  mocks.create.mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.warmup();
  });
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  h.update({ ...h.input, owner: {} });
  await act(async () => {
    pending.resolve(job);
    await task;
  });
  expect(mocks.cancel).toHaveBeenCalledWith('job');
  expect(mocks.hosted).not.toHaveBeenCalled();
});
it('does not create a job when preflight resolves after owner replacement', async () => {
  const h = harness();
  const preflight = deferred<boolean>();
  vi.mocked(h.input.prepareHosted).mockReturnValueOnce(preflight.promise);
  const old = h.hook;
  const task = old.warmup();
  h.update({ ...h.input, owner: {} });
  preflight.resolve(true);
  await task;
  await old.warmup();
  expect(mocks.create).not.toHaveBeenCalled();
});
it('persists current failures and reloads once, but never rewrites a terminal job on late cancellation', async () => {
  const h = harness();
  mocks.hosted.mockRejectedValueOnce(new Error('synthetic failure'));
  await act(async () => {
    await h.hook.warmup();
  });
  expect(mocks.finish).toHaveBeenCalledWith('job', 'failed');
  expect(h.input.notify).toHaveBeenCalledOnce();
  expect(h.input.refreshDownloads).toHaveBeenCalledOnce();
  mocks.cancel.mockClear();
  const pending = deferred<boolean>();
  mocks.hosted.mockImplementationOnce(async (...args) => {
    const download: TTSWarmupDownload = args[5];
    download.settled = true;
    return pending.promise;
  });
  let task!: Promise<void>;
  act(() => {
    task = h.hook.warmup();
  });
  await vi.waitFor(() => expect(mocks.hosted).toHaveBeenCalledTimes(2));
  h.update({ ...h.input, owner: {} });
  await act(async () => {
    pending.reject(new DOMException('cancelled', 'AbortError'));
    await task;
  });
  expect(mocks.cancel).not.toHaveBeenCalled();
});
it('honors the existing execution cancel command during preflight before a job exists', async () => {
  const h = harness();
  const preflight = deferred<boolean>();
  vi.mocked(h.input.prepareHosted).mockReturnValueOnce(preflight.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.warmup();
  });
  expect(h.execution.warmupBusy).toBe(true);
  act(() => h.execution.cancelWarmup());
  await act(async () => {
    preflight.resolve(true);
    await task;
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(h.execution.warmupBusy).toBe(false);
  expect(h.input.notify).not.toHaveBeenCalled();
});
