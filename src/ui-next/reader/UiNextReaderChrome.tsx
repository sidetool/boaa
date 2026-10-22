import { TranslateIcon } from '../../shared/ui/translate-icon';
import {
  BookmarkIcon,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  Headphones,
  Highlighter,
  ListTree,
  LocateFixed,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelRightOpen,
  Play,
  RefreshCw,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  StickyNote,
  Sun,
  Type,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { formatCount, formatProgress } from '../../utils/format';
import { showChapterSequence } from '../../features/reader/ReaderChapterHeading';
import type { ReaderChromeProps } from '../../features/reader/reader-chrome-contract';
import { normalizeReadingProfile } from '../../features/reader-settings/reading-profile';
import { ActionList, cx, Sheet, type ActionEntry } from '../components/primitives';
import { UiNextQuickView } from './UiNextQuickView';
import '../styles/tokens.css';
import '../styles/kit.css';
import './reader.css';

/**
 * ui-next reader chrome. Same props and commands as the classic chrome; visibility still follows the reader
 * screen's `chrome-visible` / `immersive` classes through the shared `reader-topbar` / `reader-bottombar` hooks.
 */
export function UiNextReaderChrome({
  model,
  screenHandle,
  viewport,
  chrome,
  search,
  location,
  mode,
  readingFlow,
  activeBookmark,
  activeHighlight,
  selection,
  mobileSearchOpen,
  overflowOpen,
  onSetMode,
  onMobileSearchOpenChanged,
  onOverflowOpenChanged,
  onGoToSavedPosition,
  onOpenAutoScroll,
  onOpenTranslation,
}: ReaderChromeProps) {
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const [highlightPending, setHighlightPending] = useState(false);
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  const actions = screenHandle.getActions();
  const progress = location?.progress ?? 0;
  const night = model.settings.theme === 'dark' || model.settings.theme === 'midnight';
  const readingProfile = normalizeReadingProfile(model.settings.readingProfile, model.settings);
  const bookOverrideEnabled = Boolean(model.settings.readingBookOverrides?.[model.novel.id]);
  const keep = model.settings.keepScreenChrome;
  const chapterLabel = showChapterSequence(model.chapter)
    ? `${formatCount(model.chapter.index)}화 · ${model.chapter.title}`
    : model.chapter.title;
  const busy = model.navigation?.busy || !viewport;
  const listening = mode === 'listen';

  const toggleBookmark = async () => {
    if (bookmarkPending) return;
    const current = location ?? viewport?.getLocation();
    if (!current) {
      actions.notify('읽기 위치를 확인하는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
      return;
    }
    setBookmarkPending(true);
    try {
      await actions.toggleBookmark(current);
    } finally {
      setBookmarkPending(false);
    }
  };
  const addHighlight = async () => {
    if (!location || !selection || highlightPending) return;
    setHighlightPending(true);
    try {
      await actions.addHighlight(location, selection);
    } finally {
      setHighlightPending(false);
    }
  };

  const more: ActionEntry[] = [
    ...(onOpenTranslation
      ? [{ id: 'translation', label: '작품 번역', icon: <TranslateIcon size={20} />, run: onOpenTranslation }]
      : []),
    {
      id: 'start',
      label: '이번 화 처음으로',
      icon: <ChevronsLeft size={20} />,
      run: () => void viewport?.scrollToParagraphIndex(0, 'start'),
    },
    {
      id: 'saved',
      label: '저장된 위치로',
      icon: <LocateFixed size={20} />,
      disabled: !model.canRestoreSavedPosition,
      run: onGoToSavedPosition,
    },
    {
      id: 'end',
      label: '이번 화 끝으로',
      icon: <ChevronsRight size={20} />,
      run: () => void viewport?.scrollToParagraphIndex(model.chapter.paragraphCount - 1, 'end'),
    },
    'divider',
    {
      id: 'highlight',
      label: selection ? '선택한 문장 하이라이트' : '하이라이트 (문장을 먼저 선택)',
      icon: <Highlighter size={20} />,
      disabled: model.transient || !selection || highlightPending,
      run: addHighlight,
    },
    ...(onOpenAutoScroll ? [{ id: 'auto', label: '자동 읽기', icon: <Play size={20} />, run: onOpenAutoScroll }] : []),
    {
      id: 'addon',
      label: '부가 기능',
      icon: <PanelRightOpen size={20} />,
      disabled: model.transient,
      run: actions.toggleAddon,
    },
    {
      id: 'sync',
      label: '동기화',
      icon: <RefreshCw size={20} />,
      disabled: model.transient,
      run: actions.openSync,
    },
    'divider',
    { id: 'settings', label: '전체 읽기 설정', icon: <Settings size={20} />, run: actions.openSettings },
    {
      id: 'fullscreen',
      label: chrome.fullscreen ? '전체 화면 끝내기' : '전체 화면',
      icon: chrome.fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />,
      run: () => void chrome.toggleFullscreen(),
    },
  ];

  return (
    <div className="ui-next un-reader-chrome">
      <div className="top-progress un-reader-progress">
        <span style={{ width: `${progress * 100}%` }} />
      </div>

      <header className={cx('reader-topbar un-reader-top', keep && 'always-visible')}>
        <button type="button" className="un-icon-btn" aria-label="화 목록으로" onClick={actions.returnToChapters}>
          <ChevronLeft size={24} />
        </button>
        <div className="un-reader-title">
          <small>{model.novel.title}</small>
          <strong>{chapterLabel}</strong>
        </div>
        <label className="un-reader-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={search.desktopInputRef}
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={search.handleInputKeyDown}
            placeholder="본문 검색"
            aria-label="본문 검색"
          />
        </label>
        <button
          type="button"
          className="un-icon-btn un-reader-search-toggle"
          aria-label="본문 검색 열기"
          aria-expanded={mobileSearchOpen}
          onClick={() => onMobileSearchOpenChanged(!mobileSearchOpen)}
        >
          <Search size={21} />
        </button>
        <button
          type="button"
          className={cx('un-icon-btn', activeBookmark && 'is-active')}
          disabled={model.transient || bookmarkPending}
          aria-label={bookmarkPending ? '북마크 저장 중' : activeBookmark ? '북마크 제거' : '북마크 추가'}
          aria-busy={bookmarkPending}
          aria-pressed={Boolean(activeBookmark)}
          onClick={() => void toggleBookmark()}
        >
          <BookmarkIcon size={21} fill={activeBookmark ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className={cx('un-icon-btn', activeHighlight && 'is-active', 'un-reader-wide')}
          onMouseDown={(event) => event.preventDefault()}
          disabled={model.transient || !selection || highlightPending}
          aria-label="선택 문장 하이라이트"
          onClick={addHighlight}
        >
          <Highlighter size={21} />
        </button>
        <button
          type="button"
          className="un-icon-btn"
          aria-label="리더 추가 메뉴"
          aria-expanded={overflowOpen}
          onClick={() => onOverflowOpenChanged(!overflowOpen)}
        >
          <MoreHorizontal size={22} />
        </button>
      </header>

      {mobileSearchOpen && (
        <div className="reader-mobile-search un-reader-mobile-search" role="search">
          <label className="un-reader-search is-open">
            <Search size={16} aria-hidden="true" />
            <input
              ref={search.mobileInputRef}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.handleInputKeyDown}
              placeholder="본문 검색"
              aria-label="모바일 본문 검색"
              autoFocus
            />
          </label>
          <button
            type="button"
            className="un-icon-btn"
            aria-label="본문 검색 닫기"
            onClick={() => onMobileSearchOpenChanged(false)}
          >
            <X size={20} />
          </button>
        </div>
      )}

      <footer className={cx('reader-bottombar un-reader-bottom', keep && 'always-visible')} aria-label="읽기 조작">
        <div className="un-reader-scrub">
          <button
            type="button"
            className="un-icon-btn"
            disabled={busy || model.chapter.index <= 1}
            aria-label="이전 화"
            onClick={() => void viewport?.goChapter(-1)}
          >
            <SkipBack size={20} />
          </button>
          <input
            className="un-reader-range"
            aria-label="읽기 진행률"
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            style={{ '--un-range': `${progress * 100}%` } as React.CSSProperties}
            onChange={(event) => void viewport?.scrubTo(Number(event.target.value) / 1000)}
            aria-valuetext={`현재 화 진행률 ${formatProgress(progress)}`}
          />
          <span className="un-reader-percent">{formatProgress(progress)}</span>
          <button
            type="button"
            className="un-icon-btn"
            disabled={busy || model.chapter.index >= model.chapters.length}
            aria-label="다음 화"
            onClick={() => void viewport?.goChapter(1)}
          >
            <SkipForward size={20} />
          </button>
        </div>
        <div className="un-reader-tools" role="toolbar" aria-label="리더 도구">
          <button
            type="button"
            className={cx('un-reader-tool', model.addonOpen && model.addonTab === 'outline' && 'is-active')}
            aria-label="목차 열기"
            onClick={() => actions.openAddon('outline')}
          >
            <ListTree size={21} />
            <span>목차</span>
          </button>
          <button
            type="button"
            className={cx('un-reader-tool', listening && 'is-active')}
            disabled={model.transient}
            aria-label={listening ? '읽기 모드' : '듣기 시작'}
            aria-pressed={listening}
            onClick={() => (listening ? onSetMode('read') : actions.startTTS(location?.ttsIndex ?? 0))}
          >
            <Headphones size={21} />
            <span>{listening ? '듣는 중' : '듣기'}</span>
          </button>
          <button
            type="button"
            className="un-reader-tool"
            aria-label="보기 설정 열기"
            onClick={() => setQuickViewOpen(true)}
          >
            <Type size={21} />
            <span>보기</span>
          </button>
          <button type="button" className="un-reader-tool" aria-label="테마 전환" onClick={actions.toggleNightTheme}>
            {night ? <Sun size={21} /> : <Moon size={21} />}
            <span>{night ? '밝게' : '어둡게'}</span>
          </button>
          <button
            type="button"
            className={cx('un-reader-tool', model.addonOpen && model.addonTab === 'notes' && 'is-active')}
            disabled={model.transient}
            aria-label="주석 열기"
            onClick={() => actions.openAddon('notes')}
          >
            <StickyNote size={21} />
            <span>주석</span>
          </button>
        </div>
      </footer>

      <Sheet open={overflowOpen} onClose={() => onOverflowOpenChanged(false)} title={chapterLabel}>
        <ActionList actions={more} onDone={() => onOverflowOpenChanged(false)} />
      </Sheet>

      <UiNextQuickView
        open={quickViewOpen}
        profile={readingProfile}
        readingFlow={readingFlow}
        bookOverrideEnabled={bookOverrideEnabled}
        onClose={() => {
          actions.flushReadingSettings();
          setQuickViewOpen(false);
        }}
        saveState={model.settingsSaveState}
        onRetrySave={actions.retryReadingSettings}
        onUpdate={actions.updateReadingProfile}
        onSetBookOverride={actions.setReadingBookOverride}
        onOpenAllSettings={actions.openSettings}
      />
    </div>
  );
}
