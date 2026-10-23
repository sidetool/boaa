import { useReaderTranslation } from '../translation/use-reader-translation';
import { ReaderTranslationContext } from '../translation/reader-translation-context';
import { ReaderTranslationControls } from '../../ui-next/reader/ReaderTranslationControls';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { ReaderPluginInput } from '../../extensions/platform/ReaderPluginInput';
import type { PluginService } from '../../extensions/platform/plugin-service';
import { useReaderDecorations } from '../../extensions/platform/use-reader-decorations';
import { useReaderPlugins } from '../../extensions/ui/ReaderPluginProvider';
import { ReaderPluginSelectionAction } from '../../extensions/ui/ReaderPluginSelectionAction';
import { captureReaderPluginSelection } from '../../extensions/ui/reader-selection';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import type { Bookmark, Chapter, Paragraph, ReaderAnchor, ReaderHighlight } from '../../domain/types';
import { useAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { ReadingPosition } from '../../sync/types';
import { ReaderChrome } from '../../ui-next/ReaderChrome';
import { ReaderSearchResults } from './ReaderSearchResults';

import { UiNextSelectionToolbar } from '../../ui-next/reader/UiNextSelectionToolbar';
import { UiNextChapterTransition } from '../../ui-next/reader/UiNextChapterTransition';
import {
  ReaderViewport,
  type ReaderAnchorPlacement,
  type ReaderRuntimeFlow,
  type ReaderViewportApi,
} from './ReaderViewport';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  OpenReaderChapterOptions,
  ReaderScreenCommands,
  ReaderScreenHandle,
  ReaderScreenModel,
  ReaderSelection,
} from './reader-screen-contract';
import { useReaderChrome } from './use-reader-chrome';
import { useReaderLifecycleFlush } from './use-reader-lifecycle-flush';
import { useReaderSearch } from './use-reader-search';
import { isInteractiveShortcutTarget, useStableDocumentShortcuts } from './use-stable-document-shortcuts';
import { dispatchReaderAction } from './reader-action-dispatcher';
import { isAndroidBackKeyboardEvent, resolveReaderTransientBackAction } from '../../platform/android/app-navigation';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { EpubFootnoteSheet } from './EpubFootnoteSheet';
import { useAutoScroll } from './use-auto-scroll';
import { AutoScrollControls } from './AutoScrollControls';

const SelectionToolbar = UiNextSelectionToolbar;

const BOOKMARK_PROGRESS_TOLERANCE = 0.003;
function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function activeBookmarkAt(
  bookmarks: readonly Bookmark[],
  chapterId: string,
  location?: ReaderLocationSnapshot,
): Bookmark | undefined {
  if (!location) return undefined;
  return bookmarks.find(
    (bookmark) =>
      bookmark.chapterId === chapterId &&
      (bookmark.paragraphId && location.paragraph?.id
        ? bookmark.paragraphId === location.paragraph.id
        : Math.abs(bookmark.progress - location.progress) <= BOOKMARK_PROGRESS_TOLERANCE),
  );
}

function activeHighlightAt(
  highlights: readonly ReaderHighlight[],
  location?: ReaderLocationSnapshot,
): ReaderHighlight | undefined {
  return location?.paragraph
    ? highlights.find((highlight) => highlight.paragraphId === location.paragraph?.id)
    : undefined;
}

export interface ReaderScreenProps {
  readonly repository?: ReaderBodyRepository;
  readonly model: ReaderScreenModel;
  /** Supplied by the approved scope provider; absent in the product until G3. */
  readonly platformPlugins?: PluginService;
  readonly onPluginAnnotationsChanged?: () => void;
  readonly screenHandle: ReaderScreenHandle;
}

function ReaderScreenComponent({
  model,
  screenHandle,
  repository: bodyRepository,
  platformPlugins,
  onPluginAnnotationsChanged,
}: ReaderScreenProps) {
  const { readerRuntime } = useAppRuntime();
  const repository = bodyRepository ?? readerRuntime.readerRepository;
  const continuous = model.settings.readingProfile.scrollChapterTransition === 'continuous';
  const chapterSessionKey = continuous ? `${model.novel.id}:${model.openRequestVersion ?? 0}` : model.chapter.id;
  const translation = useReaderTranslation(model, repository);
  const pluginRoot = useRef<HTMLElement>(null);
  const { host: pluginHost, snapshot: pluginSnapshot } = useReaderPlugins();
  useLayoutEffect(() => {
    if (!pluginHost || !model.novel.activeContentRevisionId) return;
    return pluginHost.enterReader(model.novel.id, model.novel.activeContentRevisionId);
  }, [pluginHost, model.novel.id, model.novel.activeContentRevisionId, model.chapter.id, model.openRequestVersion]);
  const viewportApiRef = useRef<ReaderViewportApi>();
  const [viewportApi, setViewportApi] = useState<ReaderViewportApi>();
  const chapterPreference = useRef({ continuous, bookId: model.novel.id });
  const preferenceAnchor = useRef<ReaderAnchor>();
  if (chapterPreference.current.continuous !== continuous) {
    if (chapterPreference.current.bookId === model.novel.id)
      preferenceAnchor.current = viewportApiRef.current?.getAnchor();
    chapterPreference.current = { continuous, bookId: model.novel.id };
  }
  useEffect(() => {
    const anchor = preferenceAnchor.current;
    if (!anchor || !viewportApi || anchor.bookId !== model.novel.id) return;
    let cancelled = false;
    void viewportApi.scrollToAnchor(anchor, 0, 'contain').then((restored) => {
      if (!cancelled && restored && preferenceAnchor.current === anchor) preferenceAnchor.current = undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [continuous, viewportApi, model.novel.id]);
  const [mode, setModeState] = useState<ReaderMode>('read');
  useReaderDecorations(platformPlugins, pluginRoot, viewportApi, model, mode, screenHandle);
  const [location, setLocation] = useState<ReaderLocationSnapshot>();
  const locationRef = useRef<ReaderLocationSnapshot>();
  const [selection, setSelection] = useState<ReaderSelection>();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [footnote, setFootnote] = useState<{
    chapter: Chapter;
    paragraphs: readonly Paragraph[];
  }>();
  const openRequest = screenHandle.peekOpen(model.chapter.id);
  const openSequence = openRequest?.sequence;
  const preserveSearch = openRequest?.preserveSearch;
  const initialMode = openRequest?.initialMode;
  const modeLock = translation.displaying ? 'scroll' : (model.settings.readingProfile.modeLock ?? 'auto');
  const [readingFlow, setReadingFlow] = useState<ReaderRuntimeFlow>(() =>
    modeLock === 'auto' ? screenHandle.getReadingFlow(model.novel.id) : modeLock,
  );
  useEffect(() => {
    screenHandle.setReadingFlow(model.novel.id, readingFlow);
  }, [screenHandle, model.novel.id, readingFlow]);
  const [pageToScrollSettling, setPageToScrollSettling] = useState(false);
  const [scrollToPageSettling, setScrollToPageSettling] = useState(false);
  const settleFrameRef = useRef<number>();
  const readingFlowRef = useRef(readingFlow);
  readingFlowRef.current = readingFlow;
  const previousModeLockRef = useRef(modeLock);
  const pendingFlowTransitionRef = useRef<{
    targetFlow: 'scroll' | 'paginated';
    anchor: ReaderAnchor;
    placement?: ReaderAnchorPlacement;
    sourceFlow?: ReaderRuntimeFlow;
    pageDelta?: number;
    entryDirection?: -1 | 1;
    scrollDelta?: number;
  }>();
  const lastFlowTransitionRef = useRef<typeof pendingFlowTransitionRef.current>();
  const pageIntentRequestRef = useRef<{
    readonly api?: ReaderViewportApi;
    readonly initialDirection: -1 | 1;
    additionalDelta: number;
  }>();

  const notify = useCallback(
    (message: string, tone: 'info' | 'success' | 'warning' | 'danger' = 'warning') => {
      screenHandle.getActions().notify(message, tone);
    },
    [screenHandle],
  );
  const openChapter = useCallback(
    (chapter: Chapter, options: OpenReaderChapterOptions = {}) =>
      screenHandle.getActions().openChapter(chapter, options),
    [screenHandle],
  );
  const scrollToParagraph = useCallback(
    (paragraphId: string) => viewportApiRef.current?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
    [],
  );
  const scrollToMatch = useCallback(async (paragraph: Paragraph) => {
    const viewport = viewportApiRef.current;
    if (!viewport) return false;
    // Use the search-only layout path; other reader navigation keeps its alignment.
    return viewport.scrollToSearchMatch?.(paragraph) ?? false;
  }, []);
  const closeSearchInput = useCallback(() => setMobileSearchOpen(false), []);
  const search = useReaderSearch({
    repository,
    novel: model.novel,
    chapter: model.chapter,
    chapters: model.chapters,
    scrollToParagraph,
    scrollToMatch,
    onClose: closeSearchInput,
    openChapter,
    notify,
  });
  const clearSearch = search.clear;
  const closeSearch = useCallback(() => {
    closeSearchInput();
    clearSearch();
  }, [clearSearch, closeSearchInput]);
  const changeMobileSearchOpen = useCallback(
    (open: boolean) => {
      if (open) setMobileSearchOpen(true);
      else closeSearch();
    },
    [closeSearch],
  );
  // Moving the result cursor must not rerender the document or its measured rows.
  const viewportSearch = useMemo(() => ({ highlightQuery: search.highlightQuery }), [search.highlightQuery]);
  const chrome = useReaderChrome(model.settings.keepScreenChrome, notify);
  const { enterImmersive, exitImmersive, immersive } = chrome;

  const flushReaderState = useCallback(() => viewportApiRef.current?.flushPosition() ?? Promise.resolve(), []);
  useReaderLifecycleFlush(flushReaderState);

  const setMode = useCallback(
    (nextMode: ReaderMode) => {
      setModeState(nextMode);
      screenHandle.getActions().modeChanged(nextMode);
    },
    [screenHandle],
  );

  const handleVisualLocation = useCallback((nextLocation: ReaderLocationSnapshot) => {
    locationRef.current = nextLocation;
    setLocation(nextLocation);
  }, []);

  const handleSelectionChanged = useCallback(
    (next: ReaderSelection | undefined) => {
      if (continuous && next) {
        const paragraph = viewportApiRef.current?.getCachedParagraphById(next.paragraphId);
        const ids =
          next.parts
            ?.map((part) => viewportApiRef.current?.getCachedParagraphById(part.paragraphId)?.chapterId)
            .filter(Boolean) ?? [];
        if (new Set(ids).size > 1) {
          setSelection(undefined);
          return;
        }
        const chapter = model.chapters.find((chapter) => chapter.id === paragraph?.chapterId);
        if (chapter && chapter.id !== model.chapter.id) screenHandle.getActions().observeChapter?.(chapter);
      }
      setSelection(next);
    },
    [continuous, model.chapters, model.chapter.id, screenHandle],
  );

  useEffect(() => {
    locationRef.current = undefined;
    setLocation(undefined);
  }, [chapterSessionKey]);

  const clearSelection = useCallback(() => {
    setSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const toggleImmersive = useCallback(() => {
    if (immersive || !chrome.visible) {
      exitImmersive();
      return;
    }
    closeSearch();
    setOverflowOpen(false);
    setFootnote(undefined);
    clearSelection();
    if (model.addonOpen) screenHandle.getActions().toggleAddon();
    enterImmersive();
  }, [
    chrome.visible,
    closeSearch,
    clearSelection,
    enterImmersive,
    exitImmersive,
    immersive,
    model.addonOpen,
    screenHandle,
  ]);

  const handleApiReady = useCallback((api?: ReaderViewportApi) => {
    viewportApiRef.current = api;
    setViewportApi(api);
  }, []);

  useEffect(() => {
    if (previousModeLockRef.current === modeLock) return;
    previousModeLockRef.current = modeLock;
    if (modeLock === 'auto') return;
    const targetFlow: ReaderRuntimeFlow = modeLock;
    if (targetFlow === readingFlow) return;
    const anchor = viewportApiRef.current?.getAnchor();
    if (anchor) {
      pendingFlowTransitionRef.current = {
        targetFlow,
        anchor,
        sourceFlow: viewportApiRef.current?.flow,
      };
      lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
      if (targetFlow === 'scroll' && readingFlow === 'paginated') {
        window.cancelAnimationFrame(settleFrameRef.current ?? 0);
        setPageToScrollSettling(true);
      }
    }
    setScrollToPageSettling(targetFlow === 'paginated' && Boolean(anchor));
    setReadingFlow(targetFlow);
  }, [modeLock, readingFlow]);

  const requestPageIntent = useCallback(
    (direction: -1 | 1) => {
      if (readingFlow === 'paginated') {
        const pending = pendingFlowTransitionRef.current;
        if (pending?.targetFlow === 'paginated') {
          pending.pageDelta = (pending.pageDelta ?? 0) + direction;
        } else if (viewportApiRef.current?.flow === 'paginated') {
          viewportApiRef.current.pageJump(direction);
        }
        return;
      }
      if (modeLock === 'scroll') {
        viewportApiRef.current?.scrollPageJump(direction);
        return;
      }
      const existingRequest = pageIntentRequestRef.current;
      if (existingRequest) {
        existingRequest.additionalDelta += direction;
        return;
      }
      const api = viewportApiRef.current;
      const request = { api, initialDirection: direction, additionalDelta: 0 };
      pageIntentRequestRef.current = request;
      const fallbackAnchor = () => {
        const current = api?.getAnchor();
        const fallbackIndex = Math.max(0, (locationRef.current?.paragraphIndex ?? 1) - 1);
        return (
          current ??
          ({
            bookId: model.novel.id,
            contentRevisionId: model.novel.activeContentRevisionId ?? `${model.novel.id}:${model.chapter.id}`,
            sectionId: model.chapter.id,
            blockId: locationRef.current?.paragraph?.id ?? '',
            blockIndex: fallbackIndex,
            offset: locationRef.current?.offsetInParagraph ?? 0,
          } satisfies ReaderAnchor)
        );
      };
      void (api?.getPageTurnAnchor(request.initialDirection) ?? Promise.resolve(undefined))
        .catch(() => undefined)
        .then((resolvedAnchor) => {
          if (pageIntentRequestRef.current !== request) return;
          pageIntentRequestRef.current = undefined;
          if (readingFlowRef.current !== 'scroll' || viewportApiRef.current?.flow !== 'scroll') return;
          const anchor = resolvedAnchor ?? fallbackAnchor();
          const targetChapter = model.chapters.find((chapter) => chapter.id === anchor.sectionId) ?? model.chapter;
          if (continuous && targetChapter.id !== model.chapter.id)
            screenHandle.getActions().observeChapter?.(targetChapter);
          const paragraph = anchor.blockId ? api?.getCachedParagraphById(anchor.blockId) : undefined;
          const atChapterEnd =
            request.initialDirection > 0 &&
            (anchor.blockIndex ?? 0) >= targetChapter.paragraphCount - 1 &&
            Boolean(paragraph && anchor.offset >= paragraph.text.length);
          const atChapterStart = request.initialDirection < 0 && (anchor.blockIndex ?? 0) <= 0 && anchor.offset <= 0;
          pendingFlowTransitionRef.current = {
            targetFlow: 'paginated',
            anchor,
            placement:
              atChapterEnd || atChapterStart
                ? 'contain'
                : request.initialDirection < 0
                  ? 'previous-page'
                  : 'page-start',
            sourceFlow: api?.flow,
            entryDirection: atChapterEnd || atChapterStart ? undefined : request.initialDirection,
            pageDelta: (atChapterEnd || atChapterStart ? request.initialDirection : 0) + request.additionalDelta,
          };
          lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
          setScrollToPageSettling(true);
          setReadingFlow('paginated');
        });
    },
    [
      modeLock,
      model.chapter,
      model.chapters,
      continuous,
      screenHandle,
      model.novel.activeContentRevisionId,
      model.novel.id,
      readingFlow,
    ],
  );

  const requestScrollIntent = useCallback(
    (deltaY: number) => {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      const activeTransition = pendingFlowTransitionRef.current;
      if (activeTransition?.targetFlow === 'scroll') {
        activeTransition.scrollDelta = (activeTransition.scrollDelta ?? 0) + deltaY;
        return;
      }
      if (readingFlow === 'scroll') {
        viewportApiRef.current?.scrollByPixels(deltaY);
        return;
      }
      if (modeLock === 'paginated') {
        viewportApiRef.current?.pageJump(deltaY > 0 ? 1 : -1);
        return;
      }
      const anchor = viewportApiRef.current?.getAnchor();
      if (!anchor) return;
      pendingFlowTransitionRef.current = {
        targetFlow: 'scroll',
        anchor,
        sourceFlow: viewportApiRef.current?.flow,
        // Keyboard/mouse input before the native scroll body is ready still
        // transfers its distance once; touch momentum uses the shared scroller.
        scrollDelta: deltaY,
      };
      lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
      window.cancelAnimationFrame(settleFrameRef.current ?? 0);
      setPageToScrollSettling(true);
      setReadingFlow('scroll');
    },
    [modeLock, readingFlow],
  );

  const acceptNativeScroll = useCallback(() => {
    if (modeLock !== 'auto' || readingFlowRef.current !== 'paginated') return;
    pendingFlowTransitionRef.current = undefined;
    setPageToScrollSettling(false);
    setScrollToPageSettling(false);
    setReadingFlow('scroll');
  }, [modeLock]);

  useEffect(() => {
    const pending = pendingFlowTransitionRef.current;
    if (pending && pending.anchor.sectionId !== model.chapter.id) {
      pendingFlowTransitionRef.current = undefined;
      return;
    }
    if (!pending || !viewportApi || pending.targetFlow !== readingFlow || viewportApi.flow !== pending.targetFlow)
      return;
    let cancelled = false;
    const animation = new AbortController();
    void viewportApi.scrollToAnchor(pending.anchor, 0, pending.placement).then(async (restored) => {
      if (cancelled || pendingFlowTransitionRef.current !== pending) return;
      if (!restored) {
        pendingFlowTransitionRef.current = undefined;
        setPageToScrollSettling(false);
        setScrollToPageSettling(false);
        setReadingFlow(pending.sourceFlow ?? 'scroll');
        return;
      }
      if (pending.entryDirection) {
        await viewportApi.animateFlowEntry?.(pending.entryDirection, animation.signal).catch(() => undefined);
        if (cancelled || pendingFlowTransitionRef.current !== pending) return;
      }
      pendingFlowTransitionRef.current = undefined;
      setScrollToPageSettling(false);
      const scrollDelta = pending.targetFlow === 'scroll' ? (pending.scrollDelta ?? 0) : 0;
      const pageDelta = pending.pageDelta ?? 0;
      const direction = Math.sign(pageDelta) as -1 | 0 | 1;
      for (let index = 0; index < Math.abs(pageDelta); index += 1) {
        if (direction) viewportApi.pageJump(direction);
      }
      if (pending.targetFlow === 'scroll') {
        window.cancelAnimationFrame(settleFrameRef.current ?? 0);
        settleFrameRef.current = window.requestAnimationFrame(() => {
          setPageToScrollSettling(false);
          if (scrollDelta) viewportApi.scrollByPixels(scrollDelta);
        });
      }
    });
    return () => {
      cancelled = true;
      animation.abort();
    };
  }, [readingFlow, viewportApi, model.chapter.id]);

  useEffect(() => {
    window.cancelAnimationFrame(settleFrameRef.current ?? 0);
    setPageToScrollSettling(false);
    setScrollToPageSettling(false);
    pendingFlowTransitionRef.current = undefined;
    pageIntentRequestRef.current = undefined;
  }, [chapterSessionKey]);

  useEffect(
    () => () => {
      window.cancelAnimationFrame(settleFrameRef.current ?? 0);
    },
    [],
  );

  const goToReadingPosition = useCallback(
    async (position: ReadingPosition): Promise<boolean> => {
      if (position.novelId !== model.novel.id) return false;
      const chapter =
        model.chapters.find((item) => item.id === position.chapterId) ??
        (await repository.getChapter(position.chapterId));
      if (!chapter) return false;
      if (chapter.id !== model.chapter.id) {
        await screenHandle.getActions().openChapter(chapter, { restore: true, position });
        return true;
      }
      if (position.paragraphIndex > 0) {
        const blockIndex = position.paragraphIndex - 1;
        const paragraph = await viewportApiRef.current?.getParagraphAtIndex(blockIndex);
        if (paragraph)
          return (
            (await viewportApiRef.current?.scrollToAnchor({
              bookId: model.novel.id,
              contentRevisionId: model.novel.activeContentRevisionId ?? `${model.novel.id}:${chapter.id}`,
              sectionId: chapter.id,
              blockId: paragraph.id,
              blockIndex,
              offset: position.offsetInParagraph,
            })) ?? false
          );
        return false;
      }
      if (position.paragraphId && (await viewportApiRef.current?.scrollToParagraph(position.paragraphId))) return true;
      await viewportApiRef.current?.scrubTo(position.chapterProgress);
      chrome.reveal();
      return true;
    },
    [
      chrome,
      model.chapter.id,
      model.chapters,
      model.novel.id,
      model.novel.activeContentRevisionId,
      repository,
      screenHandle,
    ],
  );

  const goToSavedPosition = useCallback(async () => {
    const saved =
      model.localReadingPosition?.novelId === model.novel.id
        ? model.localReadingPosition
        : await repository.getReadingPosition(model.novel.id);
    // Jumping is its own feedback; only a missing position needs explaining.
    if (saved && (await goToReadingPosition(saved))) return;
    const fallback = model.novel.lastReadChapterId
      ? (model.chapters.find((chapter) => chapter.id === model.novel.lastReadChapterId) ??
        (await repository.getChapter(model.novel.lastReadChapterId)))
      : undefined;
    if (fallback) {
      await screenHandle.getActions().openChapter(fallback, { restore: true });
    } else {
      notify('저장된 읽기 위치가 없습니다.');
    }
  }, [goToReadingPosition, model.chapters, model.localReadingPosition, model.novel, notify, repository, screenHandle]);

  const implementationRef = useRef<ReaderScreenCommands>();
  implementationRef.current = {
    resetContent: () => viewportApiRef.current?.resetContent(),
    revealChrome: chrome.reveal,
    flushSession: flushReaderState,
    setMode,
    scrollToParagraph,
    scrollToParagraphIndex: (index, align, behavior) =>
      viewportApiRef.current?.scrollToParagraphIndex(index, align, behavior) ?? Promise.resolve(),
    scrubTo: (progress) => viewportApiRef.current?.scrubTo(progress) ?? Promise.resolve(),
    goToReadingPosition,
    getParagraphAtIndex: (index) => viewportApiRef.current?.getParagraphAtIndex(index) ?? Promise.resolve(undefined),
    getCachedParagraphById: (paragraphId) => viewportApiRef.current?.getCachedParagraphById(paragraphId),
    getLocation: () => viewportApiRef.current?.getLocation() ?? locationRef.current,
    getAnchor: () => viewportApiRef.current?.getAnchor(),
    scrollToAnchor: (anchor) => viewportApiRef.current?.scrollToAnchor(anchor) ?? Promise.resolve(false),
    getSelection: () => viewportApiRef.current?.getSelection() ?? selection,
    clearSelection,
  };
  const commands = useMemo<ReaderScreenCommands>(
    () => ({
      resetContent: () => implementationRef.current?.resetContent(),
      revealChrome: () => implementationRef.current?.revealChrome(),
      flushSession: () => implementationRef.current?.flushSession() ?? Promise.resolve(),
      setMode: (nextMode) => implementationRef.current?.setMode(nextMode),
      scrollToParagraph: (paragraphId) =>
        implementationRef.current?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
      scrollToParagraphIndex: (index, align, behavior) =>
        implementationRef.current?.scrollToParagraphIndex(index, align, behavior) ?? Promise.resolve(),
      scrubTo: (progress) => implementationRef.current?.scrubTo(progress) ?? Promise.resolve(),
      goToReadingPosition: (position) =>
        implementationRef.current?.goToReadingPosition(position) ?? Promise.resolve(false),
      getParagraphAtIndex: (index) =>
        implementationRef.current?.getParagraphAtIndex(index) ?? Promise.resolve(undefined),
      getCachedParagraphById: (paragraphId) => implementationRef.current?.getCachedParagraphById(paragraphId),
      getLocation: () => implementationRef.current?.getLocation(),
      getAnchor: () => implementationRef.current?.getAnchor(),
      scrollToAnchor: (anchor) => implementationRef.current?.scrollToAnchor(anchor) ?? Promise.resolve(false),
      getSelection: () => implementationRef.current?.getSelection(),
      clearSelection: () => implementationRef.current?.clearSelection(),
    }),
    [],
  );

  useEffect(() => screenHandle.registerCommands(commands), [commands, screenHandle]);

  useEffect(() => {
    if (openSequence === undefined) return;
    setSelection(undefined);
    setFootnote(undefined);
    setOverflowOpen(false);
    if (!preserveSearch) clearSearch();
    setMode(initialMode ?? 'read');
  }, [clearSearch, initialMode, openSequence, preserveSearch, setMode]);

  const navigateToDocumentParagraph = useCallback(
    async (targetChapter: Chapter, paragraph: Paragraph) => {
      if (targetChapter.id !== model.chapter.id) {
        await screenHandle.getActions().openChapter(targetChapter, { targetParagraphId: paragraph.id });
      } else {
        await viewportApiRef.current?.scrollToParagraph(paragraph.id);
      }
    },
    [model.chapter.id, screenHandle],
  );

  const handleDocumentLink = useCallback(
    async (href: string, isFootnote: boolean) => {
      if (/^https?:\/\//i.test(href)) {
        if (window.confirm('외부 링크를 브라우저에서 열까요?')) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const targetHref = href.split('#', 1)[0];
      const currentChapter = model.chapters.find((candidate) => candidate.id === model.chapter.id);
      const candidates = [
        currentChapter,
        ...model.chapters.filter((candidate) => candidate.id !== model.chapter.id),
      ].filter((candidate): candidate is Chapter => Boolean(candidate));
      for (const candidate of candidates) {
        const matches: Paragraph[] = [];
        for (let pageIndex = 0; pageIndex < Math.ceil(candidate.paragraphCount / PARAGRAPHS_PER_PAGE); pageIndex += 1) {
          const page = await repository.getParagraphPage(candidate.id, pageIndex);
          matches.push(
            ...(page?.paragraphs.filter(
              (paragraph) =>
                paragraph.sourceHref === href ||
                (!href.includes('#') && paragraph.sourceHref?.split('#', 1)[0] === targetHref),
            ) ?? []),
          );
        }
        const target = matches[0];
        if (!target) continue;
        if (isFootnote) {
          setFootnote({ chapter: candidate, paragraphs: matches });
          return;
        }
        await navigateToDocumentParagraph(candidate, target);
        return;
      }
      notify('링크가 가리키는 위치를 찾을 수 없습니다.', 'warning');
    },
    [model.chapter.id, model.chapters, navigateToDocumentParagraph, notify, repository],
  );

  const dispatchAction = (action: 'previous_page' | 'next_page') =>
    dispatchReaderAction(action, {
      previousPage: () => requestPageIntent(-1),
      nextPage: () => requestPageIntent(1),
      toggleChrome: toggleImmersive,
      openToc: () => screenHandle.getActions().openAddon('outline'),
      openSettings: () => screenHandle.getActions().openSettings(),
      toggleTTS: () => screenHandle.getActions().toggleTTS(locationRef.current?.ttsIndex ?? 0),
    });

  useStableDocumentShortcuts(true, (event) => {
    if (event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    if (event.key === 'Escape' && footnote) {
      event.preventDefault();
      setFootnote(undefined);
      return;
    }
    const focusedButtonAllowsPageNavigation =
      ['ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) &&
      event.target instanceof HTMLElement &&
      Boolean(event.target.closest('button'));
    if (isInteractiveShortcutTarget(event.target) && !focusedButtonAllowsPageNavigation) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const actions = screenHandle.getActions();
    if (model.overlays.settingsOpen || model.overlays.syncPanelOpen || model.overlays.importOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        actions.closeActiveLayer();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (isAndroidBackKeyboardEvent(event)) {
        const backAction = resolveReaderTransientBackAction({
          overflowOpen,
          selectionOpen: Boolean(selection),
          mobileSearchOpen,
          searchActive: Boolean(search.query.trim()),
        });
        let handled = true;
        if (backAction === 'close-overflow') setOverflowOpen(false);
        else if (backAction === 'close-selection') clearSelection();
        else if (backAction === 'close-mobile-search') closeSearch();
        else if (backAction === 'clear-search') closeSearch();
        else handled = actions.closeActiveLayer();
        if (handled) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (mobileSearchOpen) closeSearch();
      else if (search.query.trim()) closeSearch();
      else if (!actions.closeActiveLayer()) chrome.hide();
      return;
    }
    if (chrome.immersive && ['/', 'b', 'h', 's', 'o', 'i', 'n'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      chrome.reveal();
      if (window.matchMedia('(max-width: 980px)').matches) setMobileSearchOpen(true);
      window.setTimeout(search.focus, 0);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      void viewportApiRef.current?.scrubTo(event.key === 'Home' ? 0 : 1);
      return;
    }
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      const direction = event.key === '[' ? -1 : 1;
      const chapter = model.chapters.find((item) => item.index === model.chapter.index + direction);
      if (chapter) void actions.openChapter(chapter, { restore: direction < 0 });
      return;
    }
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      dispatchAction('next_page');
      return;
    }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      dispatchAction('previous_page');
      return;
    }
    const key = event.key.toLowerCase();
    const currentLocation = viewportApiRef.current?.getLocation() ?? locationRef.current;
    if (key === 'b' && currentLocation) {
      event.preventDefault();
      void actions.toggleBookmark(currentLocation);
    } else if (key === 'h' && currentLocation) {
      event.preventDefault();
      actions.addHighlight(currentLocation);
    } else if (key === 's') {
      event.preventDefault();
      actions.openSettings();
    } else if (key === 'f') {
      event.preventDefault();
      void chrome.toggleFullscreen();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      actions.adjustFontSize(1);
    } else if (event.key === '-') {
      event.preventDefault();
      actions.adjustFontSize(-1);
    } else if (event.key === ',') {
      event.preventDefault();
      actions.adjustContentWidth(-40);
    } else if (event.key === '.') {
      event.preventDefault();
      actions.adjustContentWidth(40);
    } else if (key === 'o' || key === 'i' || key === 'n') {
      event.preventDefault();
      actions.openAddon(key === 'o' ? 'outline' : key === 'i' ? 'info' : 'notes');
    }
  });

  const activeBookmark = activeBookmarkAt(model.bookmarks, model.chapter.id, location);
  const [autoScrollOpen, setAutoScrollOpen] = useState(false);
  const autoScrollAllowed =
    mode === 'read' &&
    !model.activeTTSPlayback &&
    !model.overlays.settingsOpen &&
    !model.overlays.syncPanelOpen &&
    !model.overlays.importOpen &&
    !model.addonOpen &&
    !selection &&
    !footnote;
  const autoScrollReady =
    !model.navigation?.busy && viewportApi?.flow === readingFlow && !openRequest && !pageToScrollSettling;
  const nextAutoChapter = model.chapters.find((chapter) => chapter.index === model.chapter.index + 1);
  const autoScroll = useAutoScroll(
    viewportApiRef,
    continuous && readingFlow === 'scroll'
      ? `${model.novel.id}:joined`
      : (model.navigation?.scope ?? `${model.novel.id}:${model.chapter.id}`),
    autoScrollAllowed && !model.navigation?.error,
    autoScrollReady,
    nextAutoChapter && !(continuous && readingFlow === 'scroll')
      ? {
          scope: model.navigation?.nextScope ?? `${model.novel.id}:${nextAutoChapter.id}`,
          open: async (isCurrent) => {
            await viewportApiRef.current?.flushPosition();
            if (!isCurrent()) return;
            if (model.navigation?.openNext) await model.navigation.openNext(isCurrent);
            else await screenHandle.getActions().openChapter(nextAutoChapter, { restore: false });
          },
        }
      : undefined,
  );
  useEffect(() => {
    if (readingFlow === 'scroll') enterImmersive();
  }, [readingFlow, enterImmersive]);
  useEffect(() => {
    if (autoScroll.running) enterImmersive();
  }, [autoScroll.running, enterImmersive]);
  const activeHighlight = activeHighlightAt(model.highlights, location);
  return (
    <main
      ref={pluginRoot}
      className={classNames(
        'reader-screen',
        model.addonOpen && 'addon-open',
        mobileSearchOpen && 'mobile-search-open',
        chrome.immersive && 'immersive',
        pageToScrollSettling && 'page-to-scroll-settling',
        scrollToPageSettling && 'scroll-to-page-settling',
        !chrome.immersive && (chrome.visible || model.settings.keepScreenChrome) && 'chrome-visible',
      )}
      data-reading-mode-lock={modeLock}
      data-reading-flow={readingFlow}
      data-viewport-flow={viewportApi?.flow}
      data-flow-transition-anchor={lastFlowTransitionRef.current?.anchor.blockIndex}
      data-flow-transition-offset={lastFlowTransitionRef.current?.anchor.offset}
      data-flow-transition-placement={lastFlowTransitionRef.current?.placement}
      data-flow-transition-source={lastFlowTransitionRef.current?.sourceFlow}
      data-flow-transition-settling={pageToScrollSettling ? 'true' : 'false'}
      onMouseMove={chrome.reveal}
    >
      <ReaderPluginInput
        service={platformPlugins}
        onError={notify}
        generation={JSON.stringify([
          model.novel.id,
          model.chapter.id,
          model.novel.activeContentRevisionId,
          model.openRequestVersion,
          mode,
          readingFlow,
        ])}
        eligible={
          autoScrollAllowed &&
          autoScrollReady &&
          !autoScrollOpen &&
          !overflowOpen &&
          !mobileSearchOpen &&
          ['txt', 'epub'].includes(model.novel.format ?? '') &&
          readingFlow === 'scroll'
        }
        adapter={{
          bookId: model.novel.id,
          chapterId: model.chapter.id,
          contentRevision: model.novel.activeContentRevisionId ?? '',
          chapters: model.chapters,
          // Plugin annotations require the session's mutation port; the body override
          // deliberately exposes only content queries and position persistence.
          repository: readerRuntime.readerRepository,
          annotationsChanged: onPluginAnnotationsChanged,
          state: () => ({
            bookId: model.novel.id,
            chapterId: model.chapter.id,
            contentRevision: model.novel.activeContentRevisionId ?? '',
            flow: readingFlow,
            mode,
            progress: location?.progress ?? 0,
            autoScrolling: autoScroll.running,
          }),
          start: (speed) => autoScroll.startTemporary(speed),
        }}
      />
      <ReaderChrome
        onOpenTranslation={translation.available ? () => translation.setOpen(true) : undefined}
        model={model}
        screenHandle={screenHandle}
        viewport={viewportApi}
        chrome={chrome}
        search={search}
        location={location}
        mode={mode}
        readingFlow={readingFlow}
        activeBookmark={activeBookmark}
        activeHighlight={activeHighlight}
        selection={translation.displaying ? undefined : selection}
        mobileSearchOpen={mobileSearchOpen}
        overflowOpen={overflowOpen}
        onSetMode={setMode}
        onMobileSearchOpenChanged={changeMobileSearchOpen}
        onOverflowOpenChanged={setOverflowOpen}
        onGoToSavedPosition={() => void goToSavedPosition()}
        onOpenAutoScroll={() => {
          autoScroll.stop();
          setAutoScrollOpen(true);
        }}
      />
      <AutoScrollControls
        controller={autoScroll}
        open={autoScrollOpen}
        allowed={autoScrollAllowed && autoScrollReady && autoScroll.modeAllowed}
        onClose={() => setAutoScrollOpen(false)}
      />
      {search.query.trim() && (
        <aside className="reader-search-results-layer" aria-label="본문 검색 결과">
          <ReaderSearchResults
            chapterOnly={model.transient}
            search={search}
            chapters={model.chapters}
            onClose={closeSearch}
          />
        </aside>
      )}
      {(model.navigation?.pending || model.navigation?.error) && (
        <UiNextChapterTransition
          title={model.navigation.pending?.title ?? '회차'}
          phase={model.navigation.pending?.phase ?? 'opening'}
          error={model.navigation.error}
          onRetry={model.navigation.retry}
        />
      )}

      <ReaderTranslationControls controller={translation} listening={model.ttsIndex !== undefined} />
      <ReaderTranslationContext.Provider value={translation.texts}>
        <ReaderViewport
          key={chapterSessionKey}
          repository={repository}
          novel={model.novel}
          chapter={model.chapter}
          chapters={model.chapters}
          settings={model.settings}
          readingFlow={readingFlow}
          pageTransitionPending={scrollToPageSettling}
          navigationBusy={model.navigation?.busy}
          mode={mode}
          ttsIndex={model.ttsIndex}
          ttsParagraphId={model.activeTTSPlayback?.paragraphId}
          continuousSource={model.continuousSource}
          search={viewportSearch}
          screenHandle={screenHandle}
          openRequest={openRequest}
          apiRef={viewportApiRef}
          onApiReady={handleApiReady}
          onVisualLocation={handleVisualLocation}
          onSelectionChanged={handleSelectionChanged}
          onRevealChrome={chrome.reveal}
          onToggleImmersive={toggleImmersive}
          onPageIntent={requestPageIntent}
          onScrollIntent={requestScrollIntent}
          onNativeScrollIntent={acceptNativeScroll}
          onDocumentLink={handleDocumentLink}
          assetRepository={readerRuntime.bookAssetRepository}
        />
      </ReaderTranslationContext.Provider>
      {footnote && (
        <EpubFootnoteSheet
          paragraphs={footnote.paragraphs}
          onClose={() => setFootnote(undefined)}
          onOpenInDocument={() => {
            const target = footnote.paragraphs[0];
            setFootnote(undefined);
            if (target) void navigateToDocumentParagraph(footnote.chapter, target);
          }}
        />
      )}
      {selection && !model.transient && !translation.displaying && (
        <SelectionToolbar
          selection={selection}
          location={location}
          screenHandle={screenHandle}
          onClear={clearSelection}
          pluginAction={
            pluginSnapshot.entries.some((entry) => entry.commands.length) && pluginSnapshot.reader ? (
              <ReaderPluginSelectionAction
                capture={() =>
                  pluginRoot.current && pluginSnapshot.reader
                    ? captureReaderPluginSelection({
                        root: pluginRoot.current,
                        selection: window.getSelection(),
                        reader: pluginSnapshot.reader,
                        chapterId: model.chapter.id,
                        format: model.novel.format,
                        mode,
                        getParagraph: (id) => screenHandle.getCachedParagraphById(id),
                      })
                    : undefined
                }
                open={(tab) => screenHandle.getActions().openAddon(tab)}
                clear={clearSelection}
              />
            ) : undefined
          }
        />
      )}
    </main>
  );
}

export default memo(ReaderScreenComponent);
