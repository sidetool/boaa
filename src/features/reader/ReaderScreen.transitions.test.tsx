import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { UiNextChapterTransition } from '../../ui-next/reader/UiNextChapterTransition';
import { ReaderScreenHandle, type ReaderScreenModel } from './reader-screen-contract';
import { ReaderViewport } from './ReaderViewport';
import ReaderScreen from './ReaderScreen';

const mocks = vi.hoisted(() => ({
  enabled: true,
  repository: {},
  chrome: {
    visible: true,
    immersive: false,
    fullscreen: false,
    reveal: vi.fn(),
    hide: vi.fn(),
    enterImmersive: vi.fn(),
    exitImmersive: vi.fn(),
    toggleImmersive: vi.fn(),
    toggleFullscreen: vi.fn(),
  },
  search: { query: '', clear: vi.fn() },
  autoScroll: { running: false, modeAllowed: true, stop: vi.fn(), startTemporary: vi.fn() },
}));
// Keep ReaderScreen's branch and the real transition; isolate viewport/plugin/browser ownership.
vi.mock('../../app/runtime/RuntimeProvider', () => ({
  useOptionalAppRuntime: () => undefined,
  useAppRuntime: () => ({ readerRuntime: { readerRepository: mocks.repository } }),
}));
vi.mock('../../extensions/ui/ReaderPluginProvider', () => ({
  useReaderPlugins: () => ({ host: undefined, snapshot: { entries: [] } }),
}));
vi.mock('../../extensions/platform/use-reader-decorations', () => ({ useReaderDecorations: vi.fn() }));
vi.mock('../../extensions/platform/ReaderPluginInput', () => ({ ReaderPluginInput: () => null }));
vi.mock('../../ui-next/ReaderChrome', () => ({ ReaderChrome: () => null }));
vi.mock('./ReaderViewport', () => ({ ReaderViewport: () => null }));
vi.mock('./AutoScrollControls', () => ({ AutoScrollControls: () => null }));
vi.mock('./use-reader-chrome', () => ({ useReaderChrome: () => mocks.chrome }));
vi.mock('./use-reader-search', () => ({ useReaderSearch: () => mocks.search }));
vi.mock('./use-reader-lifecycle-flush', () => ({ useReaderLifecycleFlush: vi.fn() }));
vi.mock('./use-stable-document-shortcuts', () => ({
  useStableDocumentShortcuts: vi.fn(),
  isInteractiveShortcutTarget: () => false,
}));
vi.mock('./use-auto-scroll', () => ({ useAutoScroll: () => mocks.autoScroll }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { cancelAnimationFrame: vi.fn(), getSelection: () => ({ removeAllRanges: vi.fn() }) });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function fixture(navigation?: ReaderScreenModel['navigation']): ReaderScreenModel {
  const chapter = testChapter(1);
  return {
    novel: testNovel(),
    chapter,
    chapters: [chapter],
    settings: { ...defaultSettings, readingProfile: { ...defaultSettings.readingProfile } },
    bookmarks: [],
    highlights: [],
    addonOpen: false,
    addonTab: 'outline',
    overlays: { settingsOpen: false, syncPanelOpen: false, importOpen: false },
    canRestoreSavedPosition: false,
    statsVisible: false,
    openRequestVersion: 0,
    navigation,
  };
}
function mount(model: ReaderScreenModel) {
  const screenHandle = new ReaderScreenHandle();
  act(() => {
    renderer = create(<ReaderScreen model={model} screenHandle={screenHandle} />);
  });
  return { root: renderer!.root, screenHandle };
}

describe('ReaderScreen episode navigation feedback', () => {
  it.each(['importing', 'opening'] as const)(
    'shows the ui-next transition for pending phase %s over the current chapter',
    (phase) => {
      const retry = vi.fn();
      const model = fixture({ busy: true, pending: { chapterId: 'next', title: '2화', phase }, retry });
      const { root } = mount(model);
      expect(root.findByType(UiNextChapterTransition).props).toMatchObject({ title: '2화', phase, onRetry: retry });
      expect(root.findByType(ReaderViewport).props.chapter).toBe(model.chapter);
      expect(root.findAllByProps({ className: 'reader-error' })).toHaveLength(0);
    },
  );
  it.each([false, true])('shows ui-next error feedback with pending=%s and routes retry', (pending) => {
    const retry = vi.fn();
    const { root } = mount(
      fixture({
        busy: false,
        error: '회차 저장 실패',
        pending: pending ? { chapterId: 'next', title: '2화', phase: 'importing' } : undefined,
        retry,
      }),
    );
    const transition = root.findByType(UiNextChapterTransition);
    expect(transition.props).toMatchObject({
      title: pending ? '2화' : '회차',
      phase: pending ? 'importing' : 'opening',
      error: '회차 저장 실패',
      onRetry: retry,
    });
    const alert = transition.findByProps({ role: 'alert' });
    act(() => alert.findByType('button').props.onClick());
    expect(retry).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ className: 'reader-error' })).toHaveLength(0);
  });
  it('omits feedback for idle navigation and removes it after navigation finishes', () => {
    const retry = vi.fn();
    const { root, screenHandle } = mount(
      fixture({ busy: true, pending: { chapterId: 'next', title: '2화', phase: 'opening' }, retry }),
    );
    expect(root.findAllByType(UiNextChapterTransition)).toHaveLength(1);
    act(() => renderer!.update(<ReaderScreen model={fixture({ busy: false, retry })} screenHandle={screenHandle} />));
    expect(root.findAllByType(UiNextChapterTransition)).toHaveLength(0);
    expect(root.findAllByProps({ className: 'reader-error' })).toHaveLength(0);
  });
});

describe('automatic reader flow handoff', () => {
  function prepare() {
    const model = fixture();
    const { root, screenHandle } = mount(model);
    const viewport = () => root.findByType(ReaderViewport).props;
    const anchor = {
      bookId: model.novel.id,
      contentRevisionId: 'r1',
      sectionId: model.chapter.id,
      blockId: 'paragraph-2',
      blockIndex: 1,
      offset: 14,
    };
    const scroll = {
      flow: 'scroll',
      getAnchor: () => anchor,
      getPageTurnAnchor: vi.fn(async () => anchor),
      getCachedParagraphById: () => undefined,
      scrollToAnchor: vi.fn(async () => true),
      pageJump: vi.fn(),
      scrollByPixels: vi.fn(),
    };
    act(() => viewport().onApiReady(scroll));
    return { model, root, screenHandle, viewport, scroll, anchor };
  }

  it.each([-1, 1] as const)(
    'animates the first %s turn without an extra page jump, keeping the source until done',
    async (direction) => {
      const { viewport, anchor } = prepare();
      await act(async () => {
        viewport().onPageIntent(direction);
      });
      expect(viewport().readingFlow).toBe('paginated');
      expect(viewport().pageTransitionPending).toBe(true);
      let finish!: () => void;
      const page = {
        flow: 'paginated',
        scrollToAnchor: vi.fn(async () => true),
        animateFlowEntry: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
        pageJump: vi.fn(),
      };
      await act(async () => {
        viewport().onApiReady(page);
      });
      expect(page.scrollToAnchor).toHaveBeenCalledWith(anchor, 0, direction === 1 ? 'page-start' : 'previous-page');
      expect(page.animateFlowEntry).toHaveBeenCalledExactlyOnceWith(direction, expect.any(AbortSignal));
      expect(viewport().pageTransitionPending).toBe(true);
      expect(page.pageJump).not.toHaveBeenCalled();
      await act(async () => {
        finish();
      });
      expect(viewport().pageTransitionPending).toBe(false);
      expect(page.pageJump).not.toHaveBeenCalled();
      act(() => viewport().onPageIntent(direction));
      expect(page.pageJump).toHaveBeenCalledExactlyOnceWith(direction);
    },
  );

  it('accepts native scroll without restoring its anchor or injecting a synthetic scroll', async () => {
    const { viewport, scroll } = prepare();
    await act(async () => {
      viewport().onPageIntent(1);
    });
    const page = {
      flow: 'paginated',
      scrollToAnchor: vi.fn(async () => true),
      getAnchor: scroll.getAnchor,
      pageJump: vi.fn(),
    };
    await act(async () => {
      viewport().onApiReady(page);
    });
    act(() => viewport().onNativeScrollIntent());
    expect(viewport().readingFlow).toBe('scroll');
    await act(async () => {
      viewport().onApiReady(scroll);
    });
    expect(scroll.scrollToAnchor).not.toHaveBeenCalled();
    expect(scroll.scrollByPixels).not.toHaveBeenCalled();
  });

  it('aborts an entry snapshot when the chapter changes and ignores its late completion', async () => {
    const { viewport, screenHandle, model } = prepare();
    await act(async () => {
      viewport().onPageIntent(1);
    });
    let finish!: () => void;
    let signal!: AbortSignal;
    const page = {
      flow: 'paginated',
      scrollToAnchor: vi.fn(async () => true),
      pageJump: vi.fn(),
      animateFlowEntry: vi.fn((_direction: number, abort: AbortSignal) => {
        signal = abort;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    };
    await act(async () => {
      viewport().onApiReady(page);
    });
    act(() =>
      renderer!.update(<ReaderScreen model={{ ...model, chapter: testChapter(2) }} screenHandle={screenHandle} />),
    );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish();
    });
    expect(viewport().pageTransitionPending).toBe(false);
    expect(page.pageJump).not.toHaveBeenCalled();
  });
});
