import { preparedSourceOpening } from '../reader/prepared-source-opening';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReaderScreen from '../reader/ReaderScreen';
import { ReaderScreenHandle } from '../reader/reader-screen-contract';
import { defaultSettings } from '../../repositories/reader-defaults';
import { UiNextStreamLoading } from '../../ui-next/reader/UiNextStreamLoading';
import { deferred } from './source-command-test-fixtures';
import type { ReactTestInstance } from 'react-test-renderer';
import { SourceTextStreamReader } from './SourceTextStreamReader';
import { sourceTextDocument } from './source-text-document';
import { useSourceReadingPreferences } from './use-source-reading-preferences';

vi.mock('../reader/ReaderScreen', () => ({ default: vi.fn(() => null) }));
vi.mock('./use-source-reading-preferences', () => ({
  useSourceReadingPreferences: vi.fn(() => ({ mode: 'stream', prefetch: 5 })),
}));
vi.mock('./source-text-document', () => ({
  sourceTextDocument: vi.fn(async ({ episodeId, title }: { episodeId: string; title: string }) => ({
    chapter: { id: episodeId, documentSectionId: episodeId, textHash: episodeId, index: 2, paragraphCount: 1, title },
    novel: { id: 'synthetic-work', title },
    repository: { getParagraphPage: vi.fn(async () => ({ paragraphs: [{ index: 1, text: 'Synthetic' }] })) },
    flushSavedPosition: vi.fn().mockResolvedValue(undefined),
  })),
}));

let uiRenderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSourceReadingPreferences).mockReturnValue({
    mode: 'stream',
    textMode: 'stream',
    prefetch: 5,
    listMinutes: 30,
    coverHours: 24,
    imageMinutes: 2,
  });
});
afterEach(() => {
  act(() => uiRenderer?.unmount());
  uiRenderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function harness() {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  const signals: AbortSignal[] = [];
  const starts: number[] = [];
  const open = vi.fn((id: string, signal: AbortSignal) => {
    if (id === 'first') return Promise.resolve({ text: 'first' });
    signals.push(signal);
    starts.push(Date.now());
    return new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: 'next' }), 1000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const port = { kind: 'text' as const, open };
  const props = {
    port,
    remoteId: 'first',
    title: 'Synthetic',
    nextEpisode: { remoteId: 'next', title: 'Next' },
    onClose: vi.fn(),
    onSave: vi.fn(async () => {}),
    textReader: { settings: {}, settingsOpen: false, actions: { notify: vi.fn() } },
  } as unknown as Parameters<typeof SourceTextStreamReader>[0];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SourceTextStreamReader {...props} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(signals).toHaveLength(1);
  return { renderer, props, signals, starts, open };
}

it('promotes an in-flight next episode without restarting its delayed request', async () => {
  const h = await harness();
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await act(async () => {
      h.renderer.update(<SourceTextStreamReader {...h.props} remoteId="next" nextEpisode={undefined} />);
    });
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0].aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(h.open).toHaveBeenCalledTimes(2); // Current + next, no restart.
    expect(Date.now() - h.starts[0]).toBe(1000);
    expect(sourceTextDocument).toHaveBeenLastCalledWith(expect.objectContaining({ episodeId: 'next' }));
  } finally {
    await act(async () => h.renderer.unmount());
  }
});

it('cancels a pending neighbor on close', async () => {
  const h = await harness();
  await act(async () => h.renderer.unmount());
  expect(h.signals[0].aborted).toBe(true);
});

it('cancels background work immediately when hidden', async () => {
  const h = await harness();
  try {
    Object.assign(document, { visibilityState: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.signals[0].aborted).toBe(true);
  } finally {
    await act(async () => h.renderer.unmount());
  }
});

it('cancels the old account request when the owning port changes', async () => {
  const h = await harness();
  try {
    const replacement = { kind: 'text' as const, open: vi.fn(async () => ({ text: 'replacement' })) };
    await act(async () => {
      h.renderer.update(
        <SourceTextStreamReader {...h.props} port={replacement} remoteId="next" nextEpisode={undefined} />,
      );
    });
    expect(h.signals[0].aborted).toBe(true);
    expect(replacement.open).toHaveBeenCalledOnce();
  } finally {
    await act(async () => h.renderer.unmount());
  }
});

type TextProps = Parameters<typeof SourceTextStreamReader>[0];
function loadingProps(overrides: Partial<TextProps> = {}): TextProps {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  vi.mocked(useSourceReadingPreferences).mockReturnValue({
    mode: 'stream',
    textMode: 'stream',
    prefetch: 0,
    listMinutes: 30,
    coverHours: 24,
    imageMinutes: 2,
  });
  return {
    port: { kind: 'text', open: vi.fn().mockResolvedValue({ text: '본문' }) },
    remoteId: 'first',
    title: '6화',
    workTitle: '테스트 작품',
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    textReader: {
      settings: { ...defaultSettings, readingProfile: { ...defaultSettings.readingProfile } },
      settingsOpen: false,
      actions: new ReaderScreenHandle().getActions(),
    },
    ...overrides,
  };
}
async function renderLoading(props: TextProps) {
  await act(async () => {
    uiRenderer = create(<SourceTextStreamReader {...props} />);
  });
  return uiRenderer!.root;
}
function loadingText(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : loadingText(child))).join('');
}

describe('SourceTextStreamReader loading and transition UI', () => {
  it('uses the ui-next text loading stage until the first episode opens', async () => {
    const pending = deferred<{ text: string }>();
    const props = loadingProps({ port: { kind: 'text', open: vi.fn(() => pending.promise) } });
    const root = await renderLoading(props);
    expect(root.findByType(UiNextStreamLoading).props).toMatchObject({
      variant: 'text',
      workTitle: '테스트 작품',
      episodeTitle: '6화',
      onClose: props.onClose,
    });
    expect(root.findByType('main').props.className.split(' ')).toContain('is-text');
    expect(loadingText(root.findByProps({ role: 'status' }))).toBe('6화 여는 중');
    expect(root.findAllByType(ReaderScreen)).toHaveLength(0);
    await act(async () => {
      pending.resolve({ text: '본문' });
      await pending.promise;
    });
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(0);
    expect(root.findByType(ReaderScreen).props.model.chapter.title).toBe('6화');
  });
  it('uses the work title in the header', async () => {
    const props = loadingProps();
    const root = await renderLoading(props);
    const model = root.findByType(ReaderScreen).props.model;
    expect(model.novel.title).toBe('테스트 작품');
    expect(model.chapter.title).toBe('6화');
    expect(model.navigation.pending).toBeUndefined();
  });
  it('keeps the current page while moving and uses the controller-switched target title', async () => {
    const body = deferred<{ text: string }>();
    const movement = deferred<void>();
    const next = vi.fn(() => movement.promise);
    const props = loadingProps({
      port: {
        kind: 'text',
        open: vi.fn((id) => (id === 'first' ? Promise.resolve({ text: '현재 본문' }) : body.promise)),
      },
      next,
      nextEpisode: { remoteId: 'second', title: '7화' },
    });
    const root = await renderLoading(props);
    const current = root.findByType(ReaderScreen).props;
    const target = current.model.chapters.find((chapter: { title: string }) => chapter.title === '7화');
    act(() => {
      void current.screenHandle.getActions().openChapter(target);
    });
    expect(next).toHaveBeenCalledOnce();
    expect(root.findByType(ReaderScreen).props.model.navigation).toMatchObject({
      busy: true,
      pending: { title: '7화', phase: 'opening' },
    });
    expect(root.findByType(ReaderScreen).props.model.chapter.title).toBe('6화');
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(0);
    await act(async () => {
      uiRenderer!.update(
        <SourceTextStreamReader
          {...props}
          remoteId="second"
          title="7화 수정 제목"
          nextEpisode={{ remoteId: 'third', title: '8화' }}
        />,
      );
    });
    expect(root.findByType(ReaderScreen).props.model.navigation.pending.title).toBe('7화 수정 제목');
    expect(root.findByType(ReaderScreen).props.model.chapter.title).toBe('6화');
    await act(async () => {
      movement.resolve(undefined);
      body.resolve({ text: '새 본문' });
      await movement.promise;
      await body.promise;
    });
    expect(root.findByType(ReaderScreen).props.model.chapter.title).toBe('7화 수정 제목');
    expect(root.findByType(ReaderScreen).props.model.novel.title).toBe('테스트 작품');
    expect(root.findByType(ReaderScreen).props.model.navigation.pending).toBeUndefined();
    const displayed = root.findByType(ReaderScreen).props;
    expect(
      preparedSourceOpening(
        displayed.repository,
        displayed.model.novel,
        displayed.model.chapter,
        displayed.screenHandle.peekOpen(displayed.model.chapter.id),
      )?.paragraphs,
    ).toEqual([{ index: 1, text: 'Synthetic' }]);
  });
  it('shows an initial open failure in the text loading screen and retries it', async () => {
    const props = loadingProps({
      port: {
        kind: 'text',
        open: vi.fn().mockRejectedValueOnce(new Error('본문 연결 실패')).mockResolvedValue({ text: '복구한 본문' }),
      },
    });
    const root = await renderLoading(props);
    expect(root.findByType(UiNextStreamLoading).props.variant).toBe('text');
    const alert = root.findByProps({ role: 'alert' });
    expect(loadingText(alert)).toContain('본문 연결 실패');
    const retry = alert.findAllByType('button').find((node) => loadingText(node).trim() === '다시 시도')!;
    await act(async () => {
      retry.props.onClick();
    });
    expect(props.port.open).toHaveBeenCalledTimes(2);
    expect(root.findAllByType(UiNextStreamLoading)).toHaveLength(0);
    expect(root.findByType(ReaderScreen).props.model.novel.title).toBe('테스트 작품');
  });
});
