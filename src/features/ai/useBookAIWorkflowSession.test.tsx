import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import type { BookAnalysisWorkflow } from './book-analysis-workflow-gateway';
import type { BookAITTSPreparationRunner } from './book-ai-tts-preparation-runner';
import { useBookAIWorkflowSession, type BookAIWorkflowSessionInput } from './useBookAIWorkflowSession';
function workflow(bookId: string): BookAnalysisWorkflow {
  const plan: BookAIWorkflowPlan = {
    novelId: bookId,
    totalChapters: 0,
    totalCharacters: 0,
    stages: [],
    bundleWindows: [],
    labelingChapters: [],
    labelingWindows: [],
    ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
  };
  return {
    id: `workflow-${bookId}`,
    novelId: bookId,
    workflowType: 'book_ai_tts',
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    runtime: 'hosted',
    providerId: 'test',
    planHash: `plan-${bookId}`,
    plan,
    status: 'succeeded',
    stage: 'ready_for_tts',
    readiness: { outcome: 'ready_for_tts', reviewItems: [] },
    progress: {
      ttsReadiness: { ok: true },
      ttsCacheReadiness: { ok: true },
    },
    jobs: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

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
function harness() {
  const value = workflow('book');
  const runner: BookAITTSPreparationRunner = {
    id: 'moya.ai.tts.book-preparation',
    workflowVersion: '1',
    runtime: 'hosted',
    supportsTTSCacheReadiness: false,
    getPlan: vi.fn(async () => value.plan),
    restore: vi.fn(async () => undefined),
    start: vi.fn(async () => value),
    retry: vi.fn(async () => value),
    cancel: vi.fn(async () => ({ ...value, status: 'cancelled' })),
    refresh: vi.fn(async () => value),
    monitor: vi.fn(async () => value),
  };
  const input: BookAIWorkflowSessionInput = {
    sessionOwner: {},
    runner,
    bookId: 'book',
    chapterIds: [],
    openAIAddon: vi.fn(),
    notify: vi.fn(),
    repository: {
      getNovel: vi.fn(async () => undefined),
      listCharacters: vi.fn(async () => []),
      listVoiceProfiles: vi.fn(async () => []),
      listSegments: vi.fn(async () => []),
    },
    activeChapterId: () => 'chapter',
    sync: vi.fn(async () => true),
    attach: vi.fn(async () => true),
    publish: vi.fn(),
    store: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
  };
  let hook!: ReturnType<typeof useBookAIWorkflowSession>;
  function Harness({ value, open }: { value: typeof input; open?: boolean }) {
    hook = useBookAIWorkflowSession(value);
    return open ? <div /> : null;
  }
  act(() => {
    renderer = create(<Harness value={input} open />);
  });
  return {
    input,
    runner,
    get hook() {
      return hook;
    },
    update(value: typeof input) {
      act(() => renderer!.update(<Harness value={value} />));
    },
  };
}
it.each(['owner', 'book', 'unmount'])('rejects old artifact publication after %s replacement', async (kind) => {
  const h = harness();
  await act(async () => {});
  const pending = deferred<boolean>();
  vi.mocked(h.input.sync).mockReturnValueOnce(pending.promise);
  const previous = h.hook;
  const task = previous.refreshArtifacts('book');
  if (kind === 'unmount') {
    act(() => renderer!.unmount());
    renderer = undefined;
  } else h.update({ ...h.input, sessionOwner: {}, bookId: kind === 'book' ? 'other' : 'book' });
  pending.resolve(true);
  await task;
  await previous.refreshArtifacts('book');
  expect(h.input.repository.getNovel).not.toHaveBeenCalled();
  expect(h.input.publish).not.toHaveBeenCalled();
});
it('retains panel-close lifetime but prevents older artifact reads from overwriting newer reads', async () => {
  const h = harness();
  await act(async () => {});
  const pending = deferred<[]>();
  vi.mocked(h.input.repository.listCharacters).mockReturnValueOnce(pending.promise);
  const task = h.hook.refreshArtifacts('book');
  await vi.waitFor(() => expect(h.input.repository.listCharacters).toHaveBeenCalledOnce());
  h.update(h.input);
  await h.hook.refreshArtifacts('book');
  pending.resolve([]);
  await task;
  expect(h.input.publish).toHaveBeenCalledOnce();
});
it('cancels preflight without starting or attaching, and old finally cannot end a replacement start', async () => {
  const h = harness();
  await act(async () => {});
  const first = deferred<boolean>(),
    second = deferred<boolean>();
  vi.mocked(h.input.sync).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let old!: Promise<void>, fresh!: Promise<void>;
  act(() => {
    old = h.hook.start();
  });
  await act(async () => {
    await h.hook.cancel();
  });
  act(() => {
    fresh = h.hook.start();
  });
  await act(async () => {
    first.resolve(true);
    await old;
  });
  expect(h.hook.running).toBe(true);
  expect(h.input.attach).not.toHaveBeenCalled();
  expect(h.runner.start).not.toHaveBeenCalled();
  await act(async () => {
    second.resolve(true);
    await fresh;
  });
  expect(h.runner.start).toHaveBeenCalledOnce();
});
it('blocks retained commands and late restore commits after same-book owner replacement', async () => {
  const h = harness();
  await act(async () => {});
  const pending = deferred<BookAnalysisWorkflow | undefined>();
  vi.mocked(h.runner.restore).mockReturnValueOnce(pending.promise);
  h.update({ ...h.input, sessionOwner: {} });
  const previous = h.hook;
  h.update({ ...h.input, sessionOwner: {} });
  await act(async () => {});
  vi.mocked(h.input.store!.set).mockClear();
  await act(async () => {
    pending.resolve(workflow('book'));
    await Promise.resolve();
    await previous.start();
    await previous.cancel();
  });
  expect(previous.adoptWorkflow(workflow('book'))).toBe(false);
  expect(h.runner.start).not.toHaveBeenCalled();
  expect(h.input.store!.set).not.toHaveBeenCalled();
  expect(h.input.publish).not.toHaveBeenCalled();
});
it('invalidates terminal artifact adoption when cancellation supersedes an awaiting repository read', async () => {
  const h = harness();
  await act(async () => {});
  const pending = deferred<[]>();
  vi.mocked(h.input.repository.listCharacters).mockReturnValueOnce(pending.promise);
  let task!: Promise<void>;
  act(() => {
    task = h.hook.start();
  });
  await vi.waitFor(() => expect(h.input.repository.listCharacters).toHaveBeenCalledOnce());
  await act(async () => {
    await h.hook.cancel();
  });
  vi.mocked(h.input.publish).mockClear();
  await act(async () => {
    pending.resolve([]);
    await task;
  });
  expect(h.input.publish).not.toHaveBeenCalled();
  expect(h.hook.workflow?.status).toBe('cancelled');
});
