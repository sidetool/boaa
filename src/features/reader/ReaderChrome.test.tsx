import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { UiNextReaderChrome as ReaderChrome } from '../../ui-next/reader/UiNextReaderChrome';
import { ActionList } from '../../ui-next/components/primitives';
import {
  ReaderScreenHandle,
  type ReaderLocationSnapshot,
  type ReaderScreenActions,
  type ReaderScreenModel,
} from './reader-screen-contract';
import type { ReaderViewportApi } from './ReaderViewport';
import type { ReaderChromeController } from './use-reader-chrome';
import type { ReaderSearchController } from './use-reader-search';

vi.mock('../../ui-next/components/primitives', async (original) => ({
  ...(await original<typeof import('../../ui-next/components/primitives')>()),
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}));
vi.mock('../../ui-next/reader/UiNextQuickView', () => ({ UiNextQuickView: () => null }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ReaderChrome bookmark action', () => {
  it.each([false, true])(
    'keeps source-section=%s title accurate and blocks duplicate bookmark taps while saving',
    async (sourceSection) => {
      const pending = deferred();
      const toggleBookmark = vi.fn(() => pending.promise);
      const notify = vi.fn();
      const openAutoScroll = vi.fn();
      const screenHandle = new ReaderScreenHandle();
      screenHandle.setActions({ toggleBookmark, notify } as unknown as ReaderScreenActions);
      const fallbackLocation: ReaderLocationSnapshot = {
        progress: 0.37,
        scrollTop: 420,
        paragraphIndex: 12,
        ttsIndex: 12,
      };
      const goChapter = vi.fn(async () => undefined);
      const viewport = { getLocation: () => fallbackLocation, goChapter } as unknown as ReaderViewportApi;
      const model = {
        novel: { id: 'book_1', title: '모바일 책', totalChapters: 2, format: 'epub' },
        chapter: {
          id: 'chapter_1',
          novelId: 'book_1',
          index: 1,
          title: '2화 다음 이야기',
          paragraphCount: 20,
          documentSectionId: sourceSection ? 'remote-second' : undefined,
        },
        chapters: [
          { id: 'chapter_1', novelId: 'book_1', index: 1, title: '첫 화', paragraphCount: 20 },
          { id: 'chapter_2', novelId: 'book_1', index: 2, title: '둘째 화', paragraphCount: 20 },
        ],
        settings: defaultSettings,
        bookmarks: [],
        highlights: [],
        addonOpen: false,
        addonTab: 'outline',
        overlays: { settingsOpen: false, syncPanelOpen: false, importOpen: false },
        canRestoreSavedPosition: false,
        statsVisible: false,
        openRequestVersion: 0,
      } as unknown as ReaderScreenModel;
      const chrome = {
        visible: true,
        immersive: false,
        fullscreen: false,
        reveal: vi.fn(),
        hide: vi.fn(),
        enterImmersive: vi.fn(),
        exitImmersive: vi.fn(),
        toggleImmersive: vi.fn(),
        toggleFullscreen: vi.fn(async () => undefined),
      } as ReaderChromeController;
      const search = {
        query: '',
        desktopInputRef: { current: null },
        mobileInputRef: { current: null },
        setQuery: vi.fn(),
        handleInputKeyDown: vi.fn(),
      } as unknown as ReaderSearchController;

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <ReaderChrome
            model={model}
            screenHandle={screenHandle}
            viewport={viewport}
            chrome={chrome}
            search={search}
            mode="read"
            readingFlow="scroll"
            mobileSearchOpen={false}
            overflowOpen={true}
            onSetMode={vi.fn()}
            onMobileSearchOpenChanged={vi.fn()}
            onOverflowOpenChanged={vi.fn()}
            onGoToSavedPosition={vi.fn()}
            onOpenAutoScroll={openAutoScroll}
          />,
        );
      });

      expect(renderer.root.findAllByProps({ 'aria-label': '몰입 모드 시작' })).toHaveLength(0);
      const more = renderer.root.findByType(ActionList).props.actions;
      act(() => more.find((action: { id: string }) => action.id === 'auto').run());
      expect(openAutoScroll).toHaveBeenCalledOnce();
      expect(renderer.root.findByProps({ 'aria-label': '선택 문장 하이라이트' }).props.disabled).toBe(true);
      expect(renderer.root.findByProps({ className: 'un-reader-title' }).findByType('strong').children).toEqual([
        sourceSection ? '2화 다음 이야기' : '1화 · 2화 다음 이야기',
      ]);
      act(() => renderer.root.findAllByProps({ 'aria-label': '북마크 추가' })[0].props.onClick());
      expect(toggleBookmark).toHaveBeenCalledWith(fallbackLocation);
      const savingButtons = renderer.root.findAllByProps({ 'aria-label': '북마크 저장 중' });
      expect(savingButtons).toHaveLength(1);
      expect(savingButtons.every((button) => button.props.disabled)).toBe(true);

      act(() => savingButtons[0].props.onClick());
      expect(toggleBookmark).toHaveBeenCalledTimes(1);

      expect(renderer.root.findByProps({ 'aria-label': '읽기 조작' }).type).toBe('footer');
      expect(renderer.root.findByProps({ 'aria-label': '듣기 시작' }).props['aria-pressed']).toBe(false);

      act(() => renderer.root.findAllByProps({ 'aria-label': '보기 설정 열기' })[0].props.onClick());

      expect(renderer.root.findByProps({ 'aria-label': '읽기 진행률' }).props['aria-valuetext']).toBe(
        '현재 화 진행률 0%',
      );
      expect(renderer.root.findByProps({ 'aria-label': '이전 화' }).props.disabled).toBe(true);
      act(() => renderer.root.findByProps({ 'aria-label': '다음 화' }).props.onClick());
      expect(goChapter).toHaveBeenCalledWith(1);

      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      expect(
        renderer.root.findAllByProps({ 'aria-label': '북마크 추가' }).every((button) => !button.props.disabled),
      ).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      renderer.unmount();
    },
  );
});
