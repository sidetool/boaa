import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { ReaderChrome } from '../../ui-next/ReaderChrome';
import { ReaderSearchResults } from './ReaderSearchResults';
import { ReaderScreenHandle, type ReaderScreenModel } from './reader-screen-contract';
import { useStableDocumentShortcuts } from './use-stable-document-shortcuts';
import { dispatchAndroidBackEscape } from '../../platform/android/app-navigation';
import ReaderScreen from './ReaderScreen';

const mocks = vi.hoisted(() => ({
  enabled: true,
  repository: { searchParagraphPage: vi.fn() },
  viewport: { scrollToSearchMatch: vi.fn().mockResolvedValue(true) },
  viewportRender: vi.fn(),
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
vi.mock('./ReaderViewport', async () => {
  const { memo, useEffect } = await import('react');
  return {
    ReaderViewport: memo((props: import('./ReaderViewport').ReaderViewportProps) => {
      mocks.viewportRender(props.search.highlightQuery);
      useEffect(() => {
        props.apiRef.current = mocks.viewport as unknown as import('./ReaderViewport').ReaderViewportApi;
      }, [props.apiRef]);
      return null;
    }),
  };
});
vi.mock('./AutoScrollControls', () => ({ AutoScrollControls: () => null }));
vi.mock('./use-reader-chrome', () => ({ useReaderChrome: () => mocks.chrome }));
vi.mock('./use-reader-lifecycle-flush', () => ({ useReaderLifecycleFlush: vi.fn() }));
vi.mock('./use-stable-document-shortcuts', () => ({
  useStableDocumentShortcuts: vi.fn(),
  isInteractiveShortcutTarget: () => false,
}));
vi.mock('./use-auto-scroll', () => ({ useAutoScroll: () => mocks.autoScroll }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('HTMLElement', class {});
  mocks.repository.searchParagraphPage.mockResolvedValue({
    paragraphs: [1, 2].map((index) => ({ id: `p${index}`, chapterId: testChapter(1).id, index, text: 'needle' })),
    capped: false,
  });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    cancelAnimationFrame: vi.fn(),
    getSelection: () => ({ removeAllRanges: vi.fn() }),
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

describe('reader search dismissal and destination navigation', () => {
  it.each(['toolbar', 'results', 'escape', 'back', 'document-escape'] as const)(
    'closes the mobile search and clears results through %s',
    async (path) => {
      const { root } = mount(fixture());
      act(() => root.findByType(ReaderChrome).props.onMobileSearchOpenChanged(true));
      act(() => root.findByType(ReaderChrome).props.search.setQuery('needle'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(root.findAllByType(ReaderSearchResults)).toHaveLength(1);
      act(() => {
        if (path === 'toolbar') root.findByType(ReaderChrome).props.onMobileSearchOpenChanged(false);
        else if (path === 'results') root.findByProps({ 'aria-label': '본문 검색 닫기' }).props.onClick();
        else if (path === 'escape')
          root.findByType(ReaderChrome).props.search.handleInputKeyDown({ key: 'Escape', preventDefault: vi.fn() });
        else {
          const handler = vi.mocked(useStableDocumentShortcuts).mock.calls.at(-1)![1];
          const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }) as KeyboardEvent;
          if (path === 'back')
            dispatchAndroidBackEscape(
              {
                dispatchEvent: (event) => {
                  handler(event as KeyboardEvent);
                  return !event.defaultPrevented;
                },
              },
              () => event,
            );
          else handler(event);
          expect(event.defaultPrevented).toBe(true);
        }
      });
      expect(root.findByType(ReaderChrome).props.mobileSearchOpen).toBe(false);
      expect(root.findAllByType(ReaderSearchResults)).toHaveLength(0);
      expect(mocks.viewportRender).toHaveBeenLastCalledWith('');
    },
  );
  it('jumps directly to the match index without rerendering the body for a cursor change', async () => {
    const { root } = mount(fixture());
    act(() => root.findByType(ReaderChrome).props.search.setQuery('needle'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const rendered = mocks.viewportRender.mock.calls.length;
    await act(async () => {
      await root.findByType(ReaderChrome).props.search.jump(1);
    });
    expect(mocks.viewport.scrollToSearchMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 2, id: 'p2' }),
    );
    expect(mocks.viewportRender).toHaveBeenCalledTimes(rendered);
  });
});

it.each(['results', 'empty'] as const)('dismisses desktop results through %s', async (path) => {
  const { root } = mount(fixture());
  act(() => root.findByType(ReaderChrome).props.search.setQuery('needle'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  act(() => {
    if (path === 'results') root.findByProps({ 'aria-label': '본문 검색 닫기' }).props.onClick();
    else root.findByType(ReaderChrome).props.search.setQuery('');
  });
  expect(root.findAllByType(ReaderSearchResults)).toHaveLength(0);
  expect(mocks.viewportRender).toHaveBeenLastCalledWith('');
});
