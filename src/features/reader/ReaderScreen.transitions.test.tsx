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
