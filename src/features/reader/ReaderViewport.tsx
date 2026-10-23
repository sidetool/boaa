import { useContinuousTextWindow } from './use-continuous-text-window';
import type { ContinuousTextSource } from './continuous-text-window';
import { ReaderChapterLead, ReaderChapterSeparator, READER_CHAPTER_SEPARATOR_HEIGHT } from './ReaderChapterSeparator';
import { flushSync } from 'react-dom';
import { animateReaderFlow } from './reader-flow-animation';
import { useContext } from 'react';
import { ReaderTranslationContext } from '../translation/reader-translation-context';
import { readerSearchVisibleTop, useReaderSearchInset } from './reader-search-occlusion';
import { visibleTextOffset } from './visible-text-offset';
import { releaseHandoffSpace, reserveHandoffSpace } from './reader-handoff-space';
import { preparedSourceOpening } from './prepared-source-opening';

import { readReaderSelection, useReaderSelectionChanges } from './reader-selection';
import { useVirtualizer } from '@tanstack/react-virtual';
import { sentenceRanges } from '@boaa/text-core/sentence-boundaries';
import { ReaderChapterEnd } from './ReaderChapterEnd';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { Chapter, Novel, Paragraph, ReaderAnchor, ReaderSettings } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { resolveRestoreReadingPositionTarget } from '../../reader/reading-position';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import { ReaderChapterHeading } from './ReaderChapterHeading';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  ReaderOpenRequest,
  ReaderScreenHandle,
  ReaderSelection,
} from './reader-screen-contract';
import type { ReaderSearchController } from './use-reader-search';
import { useParagraphPages } from './use-paragraph-pages';
import { loadSharedParagraphPage } from './shared-paragraph-pages';
import { useReaderProgress } from './use-reader-progress';
import { PaginatedReaderViewport } from './PaginatedReaderViewport';
import { useReaderGestureHandlers } from './use-reader-gestures';
import { useScrollChapterBoundary } from './use-scroll-chapter-boundary';
import { SerializedProgressPersistence, sharedReaderPositionPersistence } from './reader-progress-controller';
import { useReaderScrollPosition } from './use-reader-scroll-position';
import { AutoReadingPresentation, type AutoReadingMode, type AutoReadingResult } from './auto-reading-modes';

export type ReaderFlowBreaks = Readonly<Record<string, readonly number[]>>;

export interface ReaderViewportApi {
  readonly flow: ReaderRuntimeFlow;
  readonly prepareScrollHandoff?: (
    anchor: ReaderAnchor,
    offsetFromTop: number,
    breaks?: ReaderFlowBreaks,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly animateFlowEntry?: (direction: -1 | 1, signal: AbortSignal) => Promise<void>;
  readonly resetContent: () => void;
  readonly flushPosition: () => Promise<void>;
  readonly scrollToSearchMatch?: (paragraph: Paragraph) => Promise<boolean>;
  readonly scrollToParagraph: (paragraphId: string) => Promise<boolean>;
  readonly scrollToParagraphIndex: (
    paragraphIndex: number,
    align?: 'start' | 'center' | 'end',
    behavior?: ScrollBehavior,
  ) => Promise<void>;
  readonly scrubTo: (progress: number) => Promise<void>;
  readonly pageJump: (direction: -1 | 1) => void;
  readonly goChapter: (direction: -1 | 1) => Promise<void>;
  readonly scrollPageJump: (direction: -1 | 1) => void;
  readonly scrollByPixels: (deltaY: number) => void;
  readonly advanceAutoScroll?: (deltaY: number, continueChapter?: boolean) => 'moving' | 'waiting' | 'end';
  readonly advanceAutoReading?: (mode: AutoReadingMode, amount: number, continueChapter?: boolean) => AutoReadingResult;
  readonly resetAutoReading?: () => void;
  readonly getAnchor: () => ReaderAnchor | undefined;
  readonly getPageTurnAnchor: (direction: -1 | 1) => Promise<ReaderAnchor | undefined>;
  readonly scrollToAnchor: (
    anchor: ReaderAnchor,
    offsetFromTop?: number,
    placement?: ReaderAnchorPlacement,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly getParagraphAtIndex: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly getCachedParagraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getLocation: () => ReaderLocationSnapshot | undefined;
  readonly getSelection: () => ReaderSelection | undefined;
}

export type ReaderRuntimeFlow = 'scroll' | 'paginated';
export type ReaderAnchorPlacement = 'contain' | 'page-start' | 'previous-page' | 'search';

export interface ReaderViewportProps {
  readonly repository: ReaderBodyRepository;
  readonly novel: Pick<Novel, 'id' | 'title' | 'totalChapters' | 'activeContentRevisionId' | 'format'>;
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly settings: ReaderSettings;
  readonly readingFlow: ReaderRuntimeFlow;
  readonly pageTransitionPending?: boolean;
  readonly navigationBusy?: boolean;
  readonly mode: ReaderMode;
  readonly ttsIndex?: number;
  readonly ttsParagraphId?: string;
  readonly continuousSource?: ContinuousTextSource;
  readonly search: Pick<ReaderSearchController, 'highlightQuery'>;
  readonly screenHandle: ReaderScreenHandle;
  readonly openRequest?: ReaderOpenRequest;
  readonly apiRef: MutableRefObject<ReaderViewportApi | undefined>;
  readonly onApiReady: (api?: ReaderViewportApi) => void;
  readonly onVisualLocation: (location: ReaderLocationSnapshot) => void;
  readonly onSelectionChanged: (selection?: ReaderSelection) => void;
  readonly onRevealChrome: () => void;
  readonly onToggleImmersive: () => void;
  readonly onPageIntent: (direction: -1 | 1) => void;
  readonly onScrollIntent: (deltaY: number) => void;
  readonly onNativeScrollIntent?: () => void;
  readonly onDocumentLink: (href: string, footnote: boolean) => void;
  readonly assetRepository?: BookAssetRepository;
}

export interface ReaderViewportLayerProps extends ReaderViewportProps {
  readonly isActive: boolean;
  readonly positionPersistence?: SerializedProgressPersistence;
  readonly pageLayer?: ReactNode;
  readonly nativeScrollReady?: boolean;
  readonly onNativeScroll?: () => void;
  readonly onScrollHandoffInvalidated?: () => void;
  readonly onPrepareNativeScroll?: (
    anchor: ReaderAnchor,
    offset: number,
    breaks?: ReaderFlowBreaks,
    signal?: AbortSignal,
  ) => Promise<void>;
}

function createViewportApiProxy(
  targetRef: MutableRefObject<ReaderViewportApi | undefined>,
  fallbackFlow: ReaderRuntimeFlow,
): ReaderViewportApi {
  const current = () => targetRef.current;
  return {
    get flow() {
      return current()?.flow ?? fallbackFlow;
    },
    resetContent: () => current()?.resetContent(),
    flushPosition: () => current()?.flushPosition() ?? Promise.resolve(),
    scrollToSearchMatch: (paragraph) => current()?.scrollToSearchMatch?.(paragraph) ?? Promise.resolve(false),
    scrollToParagraph: (paragraphId) => current()?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
    scrollToParagraphIndex: (paragraphIndex, align, behavior) =>
      current()?.scrollToParagraphIndex(paragraphIndex, align, behavior) ?? Promise.resolve(),
    scrubTo: (progress) => current()?.scrubTo(progress) ?? Promise.resolve(),
    pageJump: (direction) => current()?.pageJump(direction),
    goChapter: (direction) => current()?.goChapter(direction) ?? Promise.resolve(),
    scrollPageJump: (direction) => current()?.scrollPageJump(direction),
    scrollByPixels: (deltaY) => current()?.scrollByPixels(deltaY),
    advanceAutoScroll: (deltaY, continueChapter) => current()?.advanceAutoScroll?.(deltaY, continueChapter) ?? 'end',
    advanceAutoReading: (mode, amount, continueChapter) =>
      current()?.advanceAutoReading?.(mode, amount, continueChapter) ?? 'end',
    resetAutoReading: () => current()?.resetAutoReading?.(),
    prepareScrollHandoff: (anchor, offset, breaks, signal) =>
      current()?.prepareScrollHandoff?.(anchor, offset, breaks, signal) ?? Promise.resolve(false),
    getAnchor: () => current()?.getAnchor(),
    getPageTurnAnchor: (direction) => current()?.getPageTurnAnchor(direction) ?? Promise.resolve(undefined),
    scrollToAnchor: (anchor, offsetFromTop, placement, signal) =>
      current()?.scrollToAnchor(anchor, offsetFromTop, placement, signal) ?? Promise.resolve(false),
    getParagraphAtIndex: (paragraphIndex) =>
      current()?.getParagraphAtIndex(paragraphIndex) ?? Promise.resolve(undefined),
    getCachedParagraphById: (paragraphId) => current()?.getCachedParagraphById(paragraphId),
    getLocation: () => current()?.getLocation(),
    getSelection: () => current()?.getSelection(),
  };
}

function sourceTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    const parent = text.parentElement;
    if (text.data.length > 0 && !parent?.closest('.segment-meta, rt')) nodes.push(text);
    current = walker.nextNode();
  }
  return nodes;
}

function sourceRange(root: HTMLElement, startOffset: number, endOffset: number): Range | undefined {
  const nodes = sourceTextNodes(root);
  if (nodes.length === 0) return undefined;
  const total = nodes.reduce((sum, node) => sum + node.data.length, 0);
  const start = clamp(startOffset, 0, total);
  const end = clamp(Math.max(start + 1, endOffset), 0, total);
  let traversed = 0;
  let startPoint: { node: Text; offset: number } | undefined;
  let endPoint: { node: Text; offset: number } | undefined;
  for (const node of nodes) {
    const next = traversed + node.data.length;
    if (!startPoint && start < next) startPoint = { node, offset: Math.min(node.data.length, start - traversed) };
    if (!endPoint && end <= next) {
      endPoint = { node, offset: Math.min(node.data.length, end - traversed) };
      break;
    }
    traversed = next;
  }
  startPoint ??= { node: nodes.at(-1)!, offset: nodes.at(-1)!.data.length };
  endPoint ??= { node: nodes.at(-1)!, offset: nodes.at(-1)!.data.length };
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function readerContentTop(root: HTMLElement): number {
  const paddingTop = Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0;
  return root.getBoundingClientRect().top + paddingTop;
}

function readerContentBottom(root: HTMLElement): number {
  const paddingBottom = Number.parseFloat(window.getComputedStyle(root).paddingBottom) || 0;
  return root.getBoundingClientRect().bottom - paddingBottom;
}

function visibleParagraphOffset(root: HTMLElement, paragraphElement: HTMLElement, paragraph: Paragraph): number {
  const viewportTop = readerContentTop(root) + 1;
  if (paragraphElement.getBoundingClientRect().top >= viewportTop) return 0;
  return visibleTextOffset(paragraph.text.length, (offset) => {
    const range = sourceRange(paragraphElement, offset, offset + 1);
    // Wrapped whitespace can have zero-width fragments on both adjoining lines.
    // Use the same rectangle as scrollToAnchor, otherwise capture can select the
    // following line while restore places the preceding line at the viewport top.
    return Boolean(range && range.getBoundingClientRect().bottom > viewportTop);
  });
}

interface FullyVisibleSentence {
  readonly paragraph: Paragraph;
  readonly paragraphIndex: number;
  readonly endOffset: number;
}

function lastFullyVisibleSentence(
  root: HTMLElement,
  paragraphAt: (index: number) => Paragraph | undefined,
): FullyVisibleSentence | undefined {
  const viewportTop = readerContentTop(root) + 1;
  const viewportBottom = readerContentBottom(root) - 1;
  let candidate: FullyVisibleSentence | undefined;
  for (const element of root.querySelectorAll<HTMLElement>(':scope > .reader-document [data-paragraph-id]')) {
    const row = element.closest<HTMLElement>('[data-index]');
    const paragraphIndex = Number(row?.dataset.index);
    const paragraph = Number.isInteger(paragraphIndex) ? paragraphAt(paragraphIndex) : undefined;
    if (!paragraph || paragraph.text.length === 0) continue;
    for (const sentence of sentenceRanges(paragraph.text)) {
      const range = sourceRange(element, sentence.start, sentence.end);
      const rects = range ? [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0) : [];
      if (
        rects.length > 0 &&
        rects.every((rect) => rect.top >= viewportTop - 0.5 && rect.bottom <= viewportBottom + 0.5)
      ) {
        candidate = { paragraph, paragraphIndex, endOffset: sentence.end };
      }
    }
  }
  return candidate;
}

function hasReadableContent(paragraph: Paragraph): boolean {
  if (paragraph.documentKind === 'image') return true;
  return paragraph.text.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '').length > 0;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function VirtualizedReaderViewportComponent({
  repository,
  novel,
  chapter: activeChapter,
  chapters,
  settings,
  mode,
  ttsIndex,
  ttsParagraphId,
  continuousSource,
  search,
  screenHandle,
  openRequest,
  apiRef,
  onApiReady,
  onVisualLocation,
  onSelectionChanged,
  onRevealChrome,
  onToggleImmersive,
  onPageIntent,
  onDocumentLink,
  assetRepository,
  isActive,
  navigationBusy,
  positionPersistence,
  pageLayer,
  nativeScrollReady,
  onNativeScroll,
  onScrollHandoffInvalidated,
}: ReaderViewportLayerProps) {
  const continuous = settings.readingProfile.scrollChapterTransition === 'continuous';
  const continuousState = useContinuousTextWindow(
    continuous,
    repository,
    activeChapter,
    chapters,
    novel.activeContentRevisionId ?? novel.id,
    continuousSource,
  );
  const sequence = continuousState.window;
  const initialChapter = useRef(activeChapter);
  const sequenceCount = sequence?.count;
  const chapter = useMemo(
    () => (sequence ? { ...initialChapter.current, paragraphCount: sequenceCount ?? 0 } : activeChapter),
    [sequence, sequenceCount, activeChapter],
  );
  const localRow = (index: number) => sequence?.row(index);
  const publicAnchor = useCallback(
    (anchor: ReaderAnchor): ReaderAnchor => {
      // A preceding chapter can finish loading while an anchor is being prepared.
      // Resolve its paragraph identity again instead of retaining the old row index.
      const paragraph = sequence?.paragraphById(anchor.blockId);
      const row = sequence?.row(paragraph ? paragraph.index - 1 : (anchor.blockIndex ?? 0));
      return row ? { ...anchor, sectionId: row.entry.chapter.id, blockIndex: row.localIndex } : anchor;
    },
    [sequence],
  );
  const translationText = useContext(ReaderTranslationContext);
  const translationActive = useRef(Boolean(translationText));
  translationActive.current = Boolean(translationText);
  const translationLayout = useRef(false);
  if (translationText) translationLayout.current = true;
  const rootRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLElement>(null);
  const [searchPlacement, setSearchPlacement] = useState(Boolean(openRequest?.preserveSearch));
  const searchInset = useReaderSearchInset(rootRef, searchPlacement && Boolean(search.highlightQuery));
  useEffect(() => {
    if (!search.highlightQuery) setSearchPlacement(false);
  }, [search.highlightQuery]);
  const preparedPage = preparedSourceOpening(repository, novel, chapter, openRequest);
  const [appliedOpenSequence, setAppliedOpenSequence] = useState(preparedPage ? openRequest?.sequence : undefined);
  const [openError, setOpenError] = useState(false);
  const [openAttempt, setOpenAttempt] = useState(0);
  const opening = Boolean(openRequest?.chapterId === chapter.id && appliedOpenSequence !== openRequest.sequence);
  const visibleAnchorIndexRef = useRef<number>();
  const viewportInsetsRef = useRef({ top: 0, bottom: 0 });
  const [listOffset, setListOffset] = useState(0);
  const scrollPosition = useReaderScrollPosition(
    rootRef,
    documentRef,
    (isActive || Boolean(pageLayer)) && !opening,
    isActive || Boolean(nativeScrollReady),
    !continuous,
  );
  const nativeInput = useRef(false);
  const nativeTouch = useRef<{ x: number; y: number }>();
  const preparedHandoff = useRef<{ anchor: ReaderAnchor; offset: number }>();
  const handoffSpaceRef = useRef<HTMLDivElement>(null);
  const releaseUnusedHandoffSpace = () => {
    if (isActive && rootRef.current && handoffSpaceRef.current)
      releaseHandoffSpace(rootRef.current, handoffSpaceRef.current);
  };
  // A newly appended chapter can replace the temporary empty scroll range.
  useLayoutEffect(releaseUnusedHandoffSpace);
  const enterNativeScroll = () => {
    const root = rootRef.current;
    if (root?.contains(document.activeElement)) root.focus({ preventScroll: true });
    // Continuous React events otherwise leave the sticky page on screen for an
    // extra frame while its native scroller has already moved beneath it.
    flushSync(() => onNativeScroll?.());
  };
  // Keep the visible page's text wraps after entering scroll. A page can begin
  // inside a paragraph; joining that prefix back would reflow the displayed words.
  // Only the two page edges are split, and the original text/offsets stay intact.
  const [flowBreaks, setFlowBreaks] = useState<ReaderFlowBreaks>();
  useEffect(() => setFlowBreaks(undefined), [chapter.id, novel.activeContentRevisionId]);
  const autoPresentation = useRef(new AutoReadingPresentation());
  const autoOverlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const presentation = autoPresentation.current;
    const overlay = autoOverlayRef.current;
    if (!isActive || opening) presentation.reset(overlay);
    return () => presentation.reset(overlay);
  }, [isActive, opening]);
  const { beginNavigation, isCurrentNavigation, resetMeasurements } = scrollPosition;
  const singlePages = useParagraphPages(
    repository,
    chapter.id,
    continuous ? 0 : chapter.paragraphCount,
    novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}:${chapter.textHash}:${chapter.paragraphCount}`,
    preparedPage,
  );
  const pages = continuousState.pages ?? singlePages;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.inert = opening && isActive;
  }, [opening, isActive]);
  const virtualizer = useVirtualizer({
    count: chapter.paragraphCount,
    getItemKey: sequence?.getItemKey,
    getScrollElement: () => rootRef.current,
    observeElementOffset: scrollPosition.observeOffset,
    scrollToFn: scrollPosition.scrollTo,
    scrollMargin: listOffset,
    estimateSize: (index) =>
      sequence?.row(index)?.boundary
        ? READER_CHAPTER_SEPARATOR_HEIGHT
        : Math.max(settings.fontSize * settings.lineHeight * 2.4, 72),
    measureElement: (element) => element.getBoundingClientRect().height,
    // Measure a larger runway before rapid touch scrolling brings cold rows into
    // view. Six variable-height rows can cover less than one fast fling frame.
    overscan: 12,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = scrollPosition.adjustMeasuredSize;
  const structuralAnchor = useRef<{
    key: string | number | bigint;
    start: number;
    index: number;
    shape: string;
    margin: number;
    measuredCompensation: number;
  }>();
  const sequenceShape = sequence?.entries.map((entry) => entry.chapter.id).join('|') ?? '';
  useLayoutEffect(() => {
    if (!sequence) return;
    const previous = structuralAnchor.current;
    if (previous && previous.shape !== sequenceShape) {
      const prefixes = sequence.entries.map((entry) => `${entry.chapter.id}:`);
      for (const key of virtualizer.itemSizeCache.keys())
        if (typeof key === 'string' && !prefixes.some((prefix) => key.startsWith(prefix)))
          virtualizer.itemSizeCache.delete(key);
      // Ref measurements from the newly prepended DOM arrive before layout effects.
      // Rebuild the measured coordinates before calculating the prepend delta;
      // otherwise the estimate is committed while those real heights are lost.
      virtualizer.getTotalSize();
      const current = virtualizer.measurementsCache.find((item) => item.key === previous.key);
      if (current) {
        autoPresentation.current.shiftCoordinates(current.index - previous.index);
        scrollPosition.compensateStructure(
          current.start - previous.start,
          current.index,
          previous.measuredCompensation,
        );
        virtualizer.calculateRange();
        structuralAnchor.current = {
          key: current.key,
          start: current.start,
          index: current.index,
          shape: sequenceShape,
          margin: listOffset,
          measuredCompensation: scrollPosition.measuredCompensation,
        };
        return;
      }
    }
    // The heading can wrap differently after a prepend. Its ResizeObserver updates
    // scrollMargin in a later commit, separately from paragraph measurements.
    // Include that coordinate change without counting row size deltas twice.
    if (previous && previous.margin > 0 && previous.margin !== listOffset) {
      const delta = listOffset - previous.margin;
      scrollPosition.compensateStructure(delta, previous.index);
      virtualizer.calculateRange();
      structuralAnchor.current = { ...previous, start: previous.start + delta, margin: listOffset };
      return;
    }
    virtualizer.getTotalSize();
    const anchor = virtualizer.measurementsCache[virtualizer.range?.startIndex ?? 0];
    if (anchor)
      structuralAnchor.current = {
        key: anchor.key,
        start: anchor.start,
        index: anchor.index,
        shape: sequenceShape,
        margin: listOffset,
        measuredCompensation: scrollPosition.measuredCompensation,
      };
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const list = documentRef.current?.querySelector<HTMLElement>('.reader-virtual-list');
    if (!root || !list) return;
    const update = () => {
      const style = window.getComputedStyle(root);
      viewportInsetsRef.current = {
        top: Number.parseFloat(style.paddingTop) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
      };
      // Include the heading and reader padding in virtual scroll coordinates.
      // Layout offsets exclude the temporary chapter-boundary pull transform.
      let offset = 0;
      for (let node: HTMLElement | null = list; node && node !== root; node = node.offsetParent as HTMLElement | null) {
        offset += node.offsetTop;
      }
      setListOffset(offset);
    };
    update();
    const heading = documentRef.current?.querySelector('h1');
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (heading) observer?.observe(heading);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [chapter.id, sequence?.first.id, sequence?.first.title, searchInset]);
  const measureVirtualRow = useCallback(
    (element: Element | null) => {
      // Let the virtualizer defer row measurement during native scrolling. An immediate
      // resizeItem here bypasses that scheduling and forces layout for every mounted row.
      virtualizer.measureElement(element);
      // Translation has a different height from the source cache. Do not defer
      // its first measurement, otherwise newly mounted rows overlap in a smooth jump.
      if (translationLayout.current && element instanceof HTMLElement && element.querySelector('[data-paragraph-id]')) {
        virtualizer.resizeItem(Number(element.dataset.index), element.getBoundingClientRect().height);
      }
    },
    [virtualizer],
  );
  const measureMountedRows = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const row of documentRef.current!.querySelectorAll<HTMLElement>('.reader-virtual-row[data-index]')) {
      measureVirtualRow(row);
    }
  }, [measureVirtualRow]);
  const virtualItems = virtualizer.getVirtualItems();
  const virtualRangeKey = virtualItems.map((item) => item.index).join(':');
  const loadParagraphIndexes = pages.loadIndexes;
  // Source page identity is unchanged when a translation batch arrives. Resize
  // loaded rows now; the scroll-position controller preserves the visible anchor.
  useLayoutEffect(() => {
    if (!translationLayout.current) return;
    for (const row of documentRef.current?.querySelectorAll<HTMLElement>('.reader-virtual-row[data-index]') ?? []) {
      if (!row.querySelector('[data-paragraph-id]')) continue;
      virtualizer.resizeItem(Number(row.dataset.index), row.getBoundingClientRect().height);
    }
  }, [translationText, virtualizer, settings.fontSize, settings.lineHeight, settings.readingProfile]);

  const selectCorrectionSegment = useCallback(
    (segmentId: string) => screenHandle.getActions().selectCorrectionSegment(segmentId),
    [screenHandle],
  );

  const firstVisible = useCallback((): { index?: number; paragraph?: Paragraph; offsetInParagraph?: number } => {
    const root = rootRef.current;
    const scrollOffset = virtualizer.scrollOffset ?? root?.scrollTop ?? 0;
    // Match the reading area used by anchor restoration. Overscan inside the top
    // margin is not the saved paragraph, otherwise every reopen drifts backward.
    const viewportTop = scrollOffset + viewportInsetsRef.current.top;
    const viewportBottom = root
      ? scrollOffset + root.clientHeight - viewportInsetsRef.current.bottom
      : Number.POSITIVE_INFINITY;
    let firstAfterViewport: number | undefined;
    for (const item of virtualizer.getVirtualItems()) {
      if (sequence?.row(item.index)?.boundary) continue;
      const itemEnd = item.start + item.size;
      if (root && itemEnd <= viewportTop) continue;
      if (root && item.start >= viewportBottom) {
        firstAfterViewport ??= item.index;
        continue;
      }
      const paragraph = pages.paragraphAt(item.index);
      const element = documentRef.current?.querySelector<HTMLElement>(
        `[data-index="${item.index}"] [data-paragraph-id]`,
      );
      return {
        index: item.index,
        paragraph,
        offsetInParagraph: root && element && paragraph ? visibleParagraphOffset(root, element, paragraph) : 0,
      };
    }
    if (
      sequence &&
      firstAfterViewport === undefined &&
      root &&
      root.scrollTop >= root.scrollHeight - root.clientHeight - 2
    ) {
      const index = sequence.index(sequence.last.id, sequence.last.paragraphCount - 1);
      const paragraph = index === undefined ? undefined : pages.paragraphAt(index);
      if (paragraph) return { index, paragraph, offsetInParagraph: paragraph.text.length };
    }
    return {
      index: firstAfterViewport,
      paragraph: firstAfterViewport === undefined ? undefined : pages.paragraphAt(firstAfterViewport),
    };
  }, [pages, virtualizer, sequence]);

  const progress = useReaderProgress({
    isActive: isActive && !opening,
    positionPersistence,
    rootRef,
    repository,
    novel,
    chapter,
    resolveLocation: sequence
      ? (location) => {
          if (location.chapterId) {
            const entry = sequence.entries.find((entry) => entry.chapter.id === location.chapterId);
            return { chapter: entry?.chapter ?? activeChapter, repository: entry?.repository, location };
          }
          const row = sequence.row(Math.max(0, location.paragraphIndex - 1));
          if (!row || row.boundary)
            return { chapter: activeChapter, location: { ...location, chapterId: activeChapter.id } };
          const original = location.paragraph && sequence.original(location.paragraph);
          const max = Math.max(row.entry.chapter.paragraphCount, 1);
          const endIndex = row.start + row.entry.chapter.paragraphCount - 1;
          const end = virtualizer.measurementsCache[endIndex]?.end;
          const root = rootRef.current;
          const atEnd =
            end !== undefined &&
            root &&
            end <= root.scrollTop + scrollPosition.shift + root.clientHeight - viewportInsetsRef.current.bottom;
          return {
            chapter: row.entry.chapter,
            repository: row.entry.repository,
            location: {
              ...location,
              chapterId: row.entry.chapter.id,
              paragraph: original,
              paragraphIndex: row.localIndex + 1,
              ttsIndex: row.localIndex,
              progress: atEnd
                ? 1
                : Math.min(
                    1,
                    (row.localIndex +
                      (original?.text.length ? (location.offsetInParagraph ?? 0) / original.text.length : 0)) /
                      max,
                  ),
              scrollTop: Math.max(
                0,
                location.scrollTop + scrollPosition.shift - (virtualizer.measurementsCache[row.start]?.start ?? 0),
              ),
            },
          };
        }
      : undefined,
    getVisibleParagraph: () => {
      const visible = firstVisible();
      visibleAnchorIndexRef.current = visible.index;
      return visible;
    },
    onVisualLocation: (location) => {
      if (isActive) {
        if (sequence && location.chapterId && location.chapterId !== activeChapter.id) {
          const observed = sequence.entries.find((entry) => entry.chapter.id === location.chapterId)?.chapter;
          if (observed) {
            screenHandle.getActions().observeChapter?.(observed);
          }
        }
        onVisualLocation(location);
      }
    },
    onLocationCommitted: (nextLocation, nextBookProgress, updatedAt) =>
      screenHandle.getActions().locationCommitted(nextLocation, nextBookProgress, updatedAt),
    onPersistenceFailed: (error) => screenHandle.getActions().locationPersistenceFailed(error),
  });
  const recordVisibleLocation = progress.handleScroll;

  const scrollToParagraphIndex = useCallback(
    async (index: number, align: 'start' | 'center' | 'end' = 'center', behavior: ScrollBehavior = 'smooth') => {
      if (opening || chapter.paragraphCount <= 0) return;
      setSearchPlacement(false);
      const navigation = beginNavigation();
      let targetIndex = clamp(index, 0, chapter.paragraphCount - 1);
      const targetRow = sequence?.row(targetIndex);
      await pages.loadIndexes([targetIndex]);
      if (targetRow) {
        const current = sequence?.index(targetRow.entry.chapter.id, targetRow.localIndex);
        if (current === undefined) return;
        targetIndex = current;
      }
      if (searchPlacement) await nextFrame();
      if (!isCurrentNavigation(navigation)) return;
      virtualizer.scrollToIndex(targetIndex, { align, behavior: translationActive.current ? 'auto' : behavior });
      onRevealChrome();
    },
    [
      beginNavigation,
      chapter.paragraphCount,
      isCurrentNavigation,
      onRevealChrome,
      opening,
      pages,
      virtualizer,
      searchPlacement,
      sequence,
    ],
  );

  const scrollToParagraph = useCallback(
    async (paragraphId: string, behavior: ScrollBehavior = 'smooth'): Promise<boolean> => {
      const cached = pages.paragraphById(paragraphId);
      const paragraph =
        (cached && sequence ? sequence.original(cached) : cached) ?? (await repository.getParagraph(paragraphId));
      if (!paragraph || (!sequence && paragraph.chapterId !== chapter.id)) return false;
      const index = sequence ? sequence.index(paragraph.chapterId, paragraph.index - 1) : paragraph.index - 1;
      if (index === undefined) return false;
      await scrollToParagraphIndex(index, 'center', behavior);
      return true;
    },
    [chapter.id, pages, repository, scrollToParagraphIndex, sequence],
  );

  const scrollByPixels = useCallback(
    (deltaY: number) => {
      if (opening) return;
      const root = rootRef.current;
      if (!root || !Number.isFinite(deltaY) || deltaY === 0) return;
      root.scrollBy({ top: deltaY, behavior: 'auto' });
    },
    [opening],
  );

  const scrollPageJump = useCallback(
    (direction: -1 | 1) => {
      if (opening) return;
      const root = rootRef.current;
      if (!root) return;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const distance = Math.max(120, readerContentBottom(root) - readerContentTop(root) - 24);
      root.scrollBy({
        top: distance * direction,
        behavior: settings.readingProfile.pageTurnMotion === 'smooth' && !reducedMotion ? 'smooth' : 'auto',
      });
      onRevealChrome();
    },
    [onRevealChrome, opening, settings.readingProfile.pageTurnMotion],
  );

  const scrubTo = useCallback(
    async (value: number) => {
      if (opening) return;
      const nextProgress = clamp(value, 0, 1);
      if (chapter.paragraphCount > 0) {
        const targetIndex = clamp(
          Math.round(nextProgress * (chapter.paragraphCount - 1)),
          0,
          chapter.paragraphCount - 1,
        );
        const align = nextProgress <= 0.01 ? 'start' : nextProgress >= 0.99 ? 'end' : 'center';
        await scrollToParagraphIndex(targetIndex, align, 'auto');
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      root.scrollTop = Math.max(root.scrollHeight - root.clientHeight, 1) * nextProgress;
    },
    [chapter.paragraphCount, opening, scrollToParagraphIndex],
  );

  const goChapter = useCallback(
    async (direction: -1 | 1, openAtEnd = false) => {
      if (navigationBusy) return;
      const next = chapters.find((candidate) => candidate.index === activeChapter.index + direction);
      if (!next) return;
      if (!openAtEnd) {
        await screenHandle.getActions().openChapter(next);
        return;
      }
      await screenHandle.getActions().openChapter(next, {
        restore: true,
        position: {
          id: `chapter_edge_${next.id}`,
          novelId: novel.id,
          chapterId: next.id,
          paragraphIndex: Math.max(next.paragraphCount, 1),
          offsetInParagraph: 0,
          chapterProgress: 1,
          scrollTop: Number.MAX_SAFE_INTEGER,
          deviceId: 'reader',
          updatedAt: new Date().toISOString(),
        },
      });
    },
    [activeChapter.index, chapters, novel.id, screenHandle, navigationBusy],
  );
  const nextChapter = chapters.find((candidate) => candidate.index === chapter.index + 1);
  const nextChapterId = nextChapter?.id;
  const nextChapterCount = nextChapter?.paragraphCount ?? 0;
  const nextChapterRevision =
    novel.activeContentRevisionId ?? `${novel.id}:${nextChapterId}:${nextChapter?.textHash}:${nextChapterCount}`;
  useEffect(() => {
    if (continuous || !isActive || opening || !nextChapterId || nextChapterCount === 0) return;
    // Scroll readers also prepare one opening page after the current opening
    // settles. Switching chapters joins this request through the shared cache.
    const timer = window.setTimeout(() => {
      void loadSharedParagraphPage(repository, nextChapterRevision, nextChapterId, 0).catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [continuous, isActive, opening, nextChapterId, nextChapterCount, nextChapterRevision, repository]);
  const scrollChapterBoundary = useScrollChapterBoundary({
    rootRef,
    contentRef: documentRef,
    chapterId: chapter.id,
    enabled: !continuous && isActive && !opening && !navigationBusy && Boolean(nextChapter),
    onNextChapter: () => goChapter(1),
  });

  const getSelection = useCallback((): ReaderSelection | undefined => {
    return readReaderSelection(documentRef.current);
  }, []);

  useReaderSelectionChanges(getSelection, onSelectionChanged, isActive && !opening);

  const updateSelection = useCallback(() => {
    if (isActive) window.setTimeout(() => onSelectionChanged(getSelection()), 0);
  }, [getSelection, onSelectionChanged, isActive]);

  const getVisibleAnchor = useCallback((): ReaderAnchor | undefined => {
    if (opening) return undefined;
    const root = rootRef.current;
    if (root) {
      const viewportTop = readerContentTop(root);
      const viewportBottom = readerContentBottom(root);
      for (const element of documentRef.current!.querySelectorAll<HTMLElement>('[data-paragraph-id]')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= viewportTop + 1 || rect.top >= viewportBottom) continue;
        const row = element.closest<HTMLElement>('[data-index]');
        const blockIndex = Number(row?.dataset.index);
        const paragraph = Number.isInteger(blockIndex) ? pages.paragraphAt(blockIndex) : undefined;
        if (!paragraph) continue;
        return publicAnchor({
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex,
          offset: visibleParagraphOffset(root, element, paragraph),
          sourceLocator: paragraph.sourceLocator,
        });
      }
    }
    const current = progress.readLocation();
    const localIndex = Math.max(0, (current?.paragraphIndex ?? 1) - 1);
    const blockIndex = sequence?.index(current?.chapterId ?? activeChapter.id, localIndex) ?? localIndex;
    const paragraph = pages.paragraphAt(blockIndex) ?? current?.paragraph;
    if (!paragraph) return undefined;
    return publicAnchor({
      bookId: novel.id,
      contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
      sectionId: chapter.id,
      blockId: paragraph.id,
      blockIndex,
      offset: current?.offsetInParagraph ?? 0,
      sourceLocator: paragraph.sourceLocator,
    });
  }, [
    chapter.id,
    novel.activeContentRevisionId,
    novel.id,
    opening,
    pages,
    progress,
    publicAnchor,
    sequence,
    activeChapter.id,
  ]);

  const getPageTurnAnchor = useCallback(
    async (direction: -1 | 1): Promise<ReaderAnchor | undefined> => {
      if (opening) return undefined;
      const root = rootRef.current;
      if (root) {
        const indexes = [...documentRef.current!.querySelectorAll<HTMLElement>('[data-index]')]
          .map((element) => Number(element.dataset.index))
          .filter(Number.isInteger);
        const lastIndex = indexes.at(-1);
        if (lastIndex !== undefined) {
          for (let index = lastIndex + 1; index <= Math.min(lastIndex + 6, chapter.paragraphCount - 1); index += 1) {
            indexes.push(index);
          }
        }
        await pages.loadIndexes(indexes);
      }
      if (direction < 0) return getVisibleAnchor();
      const activeRoot = rootRef.current;
      const candidate = activeRoot ? lastFullyVisibleSentence(activeRoot, pages.paragraphAt) : undefined;
      if (!candidate) return getVisibleAnchor();
      if (candidate.endOffset < candidate.paragraph.text.length) {
        return publicAnchor({
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: candidate.paragraph.id,
          blockIndex: candidate.paragraphIndex,
          offset: candidate.endOffset,
          sourceLocator: candidate.paragraph.sourceLocator,
        });
      }
      for (let index = candidate.paragraphIndex + 1; index < (sequence?.count ?? chapter.paragraphCount); index += 1) {
        const paragraph = pages.paragraphAt(index) ?? (await pages.getParagraphAt(index));
        if (!paragraph) continue;
        index = paragraph.index - 1;
        if (!hasReadableContent(paragraph)) continue;
        return publicAnchor({
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: index,
          offset: 0,
          sourceLocator: paragraph.sourceLocator,
        });
      }
      return publicAnchor({
        bookId: novel.id,
        contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
        sectionId: chapter.id,
        blockId: candidate.paragraph.id,
        blockIndex: candidate.paragraphIndex,
        offset: candidate.endOffset,
        sourceLocator: candidate.paragraph.sourceLocator,
      });
    },
    [
      chapter.id,
      chapter.paragraphCount,
      getVisibleAnchor,
      novel.activeContentRevisionId,
      novel.id,
      opening,
      pages,
      publicAnchor,
      sequence,
    ],
  );

  apiRef.current = {
    flow: 'scroll',
    resetContent: pages.reset,
    flushPosition: async () => {
      // Opening a chapter is read activity even when no scroll event occurred.
      if (isActive) recordVisibleLocation();
      await progress.flush();
    },
    scrollToSearchMatch: (paragraph) =>
      apiRef.current?.scrollToAnchor(
        {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: paragraph.chapterId,
          blockId: paragraph.id,
          blockIndex: paragraph.index - 1,
          offset: 0,
        },
        0,
        'search',
      ) ?? Promise.resolve(false),
    scrollToParagraph,
    scrollToParagraphIndex: (index, align, behavior) =>
      scrollToParagraphIndex(sequence?.index(activeChapter.id, index) ?? index, align, behavior),
    scrubTo: sequence
      ? (value) =>
          scrollToParagraphIndex(
            sequence.index(activeChapter.id, Math.round(value * Math.max(0, activeChapter.paragraphCount - 1))) ?? 0,
            'start',
            'auto',
          )
      : scrubTo,
    pageJump: onPageIntent,
    goChapter: (direction) => goChapter(direction, direction < 0),
    scrollPageJump,
    scrollByPixels,
    advanceAutoScroll: (deltaY, continueChapter = false) => {
      const root = rootRef.current;
      if (!isActive || !root || opening) return 'waiting';
      // Do not scroll through unloaded rows or let a delayed body consume reading time.
      if (virtualizer.getVirtualItems().some((item) => !pages.paragraphAt(item.index))) return 'waiting';
      if (
        documentRef.current?.querySelector('.reader-image-placeholder.is-loading') ||
        [...(documentRef.current?.querySelectorAll('img') ?? [])].some((image) => !image.complete)
      )
        return 'waiting';
      let end = root.scrollHeight - root.clientHeight;
      if (sequence && !continueChapter) {
        const lastIndex = sequence.index(activeChapter.id, activeChapter.paragraphCount - 1);
        const last = lastIndex === undefined ? undefined : virtualizer.measurementsCache[lastIndex];
        if (last) end = Math.min(end, Math.max(0, last.end - scrollPosition.shift - root.clientHeight));
      }
      if (end - root.scrollTop <= 1) {
        if (sequence && continueChapter && sequence.status(1) !== 'end') {
          if (sequence.status(1) === 'error') return 'end';
          void sequence.prepare(1);
          return 'waiting';
        }
        return 'end';
      }
      if (Number.isFinite(deltaY) && deltaY > 0)
        root.scrollBy({ top: Math.min(deltaY, end - root.scrollTop), behavior: 'auto' });
      return 'moving';
    },
    getAnchor: getVisibleAnchor,
    resetAutoReading: () => autoPresentation.current.reset(autoOverlayRef.current),
    advanceAutoReading: (autoMode, amount, continueChapter = false) => {
      const root = rootRef.current;
      const overlay = autoOverlayRef.current;
      if (!root || !overlay || opening || !isActive) return 'waiting';
      const result = autoPresentation.current.advance(autoMode, amount, {
        root,
        contentRoot: documentRef.current ?? undefined,
        overlay,
        top: readerContentTop(root),
        bottom: readerContentBottom(root),
        count:
          sequence && !continueChapter
            ? (sequence.index(activeChapter.id, activeChapter.paragraphCount - 1) ?? 0) + 1
            : chapter.paragraphCount,
        anchor: () => {
          const anchor = getVisibleAnchor();
          return anchor && sequence
            ? { ...anchor, blockIndex: sequence.index(anchor.sectionId, anchor.blockIndex ?? 0) ?? anchor.blockIndex }
            : anchor;
        },
        paragraph: pages.paragraphAt,
        load: async (index, isCurrent) => {
          const row = sequence?.row(index);
          await pages.loadIndexes([index]);
          if (!isCurrent()) return;
          const current = row ? sequence?.index(row.entry.chapter.id, row.localIndex) : index;
          if (current === undefined) return;
          beginNavigation();
          virtualizer.scrollToIndex(current, { align: 'start', behavior: 'auto' });
        },
        range: sourceRange,
        advance: (pixels) => apiRef.current?.advanceAutoScroll?.(pixels, continueChapter) ?? 'waiting',
      });
      if (
        result === 'end' &&
        sequence &&
        continueChapter &&
        sequence.status(1) !== 'end' &&
        sequence.status(1) !== 'error'
      ) {
        void sequence.prepare(1);
        return 'waiting';
      }
      return result;
    },
    getPageTurnAnchor,
    prepareScrollHandoff: async (anchor, offset, breaks, signal) => {
      if (signal?.aborted) return false;
      setFlowBreaks(breaks);
      await nextFrame();
      const restored = await apiRef.current?.scrollToAnchor(anchor, offset, 'page-start', signal);
      if (restored && !signal?.aborted) preparedHandoff.current = { anchor, offset };
      if (restored && openRequest?.chapterId === chapter.id) setAppliedOpenSequence(openRequest.sequence);
      return Boolean(restored);
    },
    scrollToAnchor: async (anchor, offsetFromTop = 0, placement, signal) => {
      if (signal?.aborted) return false;
      if (!sequence && anchor.sectionId !== chapter.id) return false;
      const sequenceIndex = sequence?.index(anchor.sectionId, anchor.blockIndex ?? 0);
      if (sequence && sequenceIndex === undefined) return false;
      setSearchPlacement(placement === 'search');
      const navigation = beginNavigation();
      let targetIndex = clamp(sequenceIndex ?? anchor.blockIndex ?? 0, 0, Math.max(0, chapter.paragraphCount - 1));
      await pages.loadIndexes([targetIndex]);
      if (!isCurrentNavigation(navigation) || signal?.aborted) return false;
      if (sequence) {
        const current = sequence.index(anchor.sectionId, anchor.blockIndex ?? 0);
        if (current === undefined) return false;
        targetIndex = current;
      }
      virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
      // Retain measurements across flow switches. Re-measuring every
      // mounted row for up to 40 frames made this handoff visibly stall on iPad WebKit. Measure
      // the target row once, then apply at most two exact range corrections.
      const targetElement = () => {
        if (sequence) {
          const current = sequence.index(anchor.sectionId, anchor.blockIndex ?? 0);
          if (current === undefined) return undefined;
          targetIndex = current;
        }
        const root = rootRef.current;
        if (!root) return undefined;
        return (
          [...documentRef.current!.querySelectorAll<HTMLElement>('[data-paragraph-id]')].find(
            (element) => element.dataset.paragraphId === anchor.blockId,
          ) ?? documentRef.current!.querySelector<HTMLElement>(`[data-index="${targetIndex}"] [data-paragraph-id]`)
        );
      };
      await nextFrame();
      if (!isCurrentNavigation(navigation) || signal?.aborted) return false;
      let paragraphElement = targetElement();
      if (!paragraphElement) {
        virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
        await nextFrame();
        if (!isCurrentNavigation(navigation) || signal?.aborted) return false;
        paragraphElement = targetElement();
      }
      if (!paragraphElement) return false;
      const targetRow = paragraphElement.closest<HTMLElement>('.reader-virtual-row[data-index]');
      if (targetRow) virtualizer.resizeItem(targetIndex, targetRow.getBoundingClientRect().height);
      virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await nextFrame();
        if (!isCurrentNavigation(navigation) || signal?.aborted) return false;
        const root = rootRef.current;
        if (!root) return false;
        paragraphElement = targetElement();
        if (!paragraphElement) return false;
        const range = sourceRange(paragraphElement, anchor.offset, anchor.offset + 1);
        const rect = range?.getBoundingClientRect() ?? paragraphElement.getBoundingClientRect();
        const contentTop = readerContentTop(root);
        const top = placement === 'search' ? readerSearchVisibleTop(root, contentTop) : contentTop + offsetFromTop;
        const correction = rect.top - top;
        if (Math.abs(correction) <= 1) return true;
        if (placement === 'page-start' && handoffSpaceRef.current)
          reserveHandoffSpace(root, handoffSpaceRef.current, root.scrollTop + correction);
        root.scrollTop += correction;
      }
      return true;
    },
    getParagraphAtIndex: async (index) => {
      const paragraph = await pages.getParagraphAt(sequence?.index(activeChapter.id, index) ?? index);
      return paragraph && sequence ? sequence.original(paragraph) : paragraph;
    },
    getCachedParagraphById: (id) => {
      const paragraph = pages.paragraphById(id);
      return paragraph && sequence ? sequence.original(paragraph) : paragraph;
    },
    getLocation: () => (opening ? undefined : progress.readLocation()),
    getSelection,
  };

  useLayoutEffect(() => {
    onApiReady(apiRef.current);
    return () => onApiReady(undefined);
  }, [apiRef, chapter.id, onApiReady]);

  useLayoutEffect(() => {
    // Both flow layers stay mounted at the same width. A visibility switch is not a layout
    // change: clearing sizes here makes upward scrolling rediscover every previous row.
    resetMeasurements();
    virtualizer.measure();
    measureMountedRows();
  }, [
    chapter.id,
    measureMountedRows,
    resetMeasurements,
    settings.fontSize,
    settings.readingProfile.fontStyle,
    settings.readingProfile.letterSpacing,
    settings.readingProfile.lineBreak,
    settings.readingProfile.textDecoration,
    settings.readingProfile.wordSpacing,
    settings.lineHeight,
    settings.paragraphSpacing,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const documentElement = documentRef.current;
    if (!documentElement || typeof ResizeObserver === 'undefined') return;
    let lastWidth = documentElement.getBoundingClientRect().width;
    let restoreFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      const nextWidth = documentElement.getBoundingClientRect().width;
      if (Math.abs(nextWidth - lastWidth) < 1) return;
      lastWidth = nextWidth;
      const anchorIndex = visibleAnchorIndexRef.current ?? firstVisible().index;
      if (anchorIndex === undefined) return;
      const navigation = beginNavigation();
      window.cancelAnimationFrame(restoreFrame ?? 0);
      restoreFrame = window.requestAnimationFrame(() => {
        if (!isCurrentNavigation(navigation)) return;
        resetMeasurements();
        virtualizer.measure();
        restoreFrame = window.requestAnimationFrame(() => {
          if (!isCurrentNavigation(navigation)) return;
          measureMountedRows();
          virtualizer.scrollToIndex(anchorIndex, { align: 'start', behavior: 'auto' });
        });
      });
    });
    observer.observe(documentElement);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(restoreFrame ?? 0);
    };
  }, [
    beginNavigation,
    chapter.id,
    firstVisible,
    isCurrentNavigation,
    measureMountedRows,
    resetMeasurements,
    virtualizer,
  ]);

  // TanStack drops (not defers) row measurements outside the target window while a smooth
  // scrollToIndex runs. TTS follows every paragraph with one, so rows mounting at the leading
  // overscan edge keep their estimate and later overlap. Re-read mounted rows once it settles.
  const scrollSettled = !virtualizer.isScrolling;
  useEffect(() => {
    const root = rootRef.current;
    if (!scrollSettled || opening || !root) return;
    for (const row of documentRef.current!.querySelectorAll<HTMLElement>('.reader-virtual-row[data-index]')) {
      if (!row.querySelector('[data-paragraph-id]')) continue;
      virtualizer.resizeItem(Number(row.dataset.index), row.getBoundingClientRect().height);
    }
  }, [opening, scrollSettled, virtualRangeKey, virtualizer]);

  // Playback skips follow-scrolling while the page is hidden; catch up once on return.
  const ttsPositionRef = useRef({ index: ttsIndex, paragraphId: ttsParagraphId });
  ttsPositionRef.current = { index: ttsIndex, paragraphId: ttsParagraphId };
  useEffect(() => {
    if (!isActive) return;
    let hiddenAt: typeof ttsPositionRef.current | undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = ttsPositionRef.current;
        return;
      }
      const { index, paragraphId } = ttsPositionRef.current;
      if (index !== undefined && (index !== hiddenAt?.index || paragraphId !== hiddenAt?.paragraphId)) {
        if (sequence && paragraphId) void scrollToParagraph(paragraphId, 'auto');
        else void scrollToParagraphIndex(sequence?.index(activeChapter.id, index) ?? index, 'center', 'auto');
      }
      hiddenAt = undefined;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [isActive, scrollToParagraph, scrollToParagraphIndex, sequence, activeChapter.id]);

  useEffect(() => {
    if (opening) return;
    const activeItems = virtualizer.getVirtualItems();
    if (activeItems.length === 0) return;
    const indexes = activeItems.map((item) => item.index);
    const generation = pages.generation;
    let cancelled = false;
    void pages.loadIndexes(indexes).then(() => {
      if (!cancelled && pagesRef.current.generation === generation) {
        pages.prune(indexes);
        if (isActive) pages.prefetchAdjacent(indexes);
      }
    });
    return () => {
      cancelled = true;
      pages.prefetchAdjacent([]);
    };
  }, [isActive, opening, pages, virtualRangeKey, virtualizer]);

  useEffect(() => {
    if (!opening || !isActive || !openRequest) return;
    let cancelled = false;
    setOpenError(false);
    const restore = async () => {
      const explicitParagraph = openRequest.targetParagraphId
        ? await repository.getParagraph(openRequest.targetParagraphId)
        : undefined;
      const resolvedParagraph =
        openRequest.restore && openRequest.position?.paragraphIndex === 0 && openRequest.position.paragraphId
          ? await repository.getParagraph(openRequest.position.paragraphId)
          : undefined;
      if (cancelled) return;
      const target =
        explicitParagraph?.chapterId === chapter.id
          ? { canRestore: true, paragraphIndex: explicitParagraph.index - 1, scrollTop: 0 }
          : openRequest.restore
            ? resolveRestoreReadingPositionTarget(chapter, openRequest.position, resolvedParagraph)
            : { canRestore: false, scrollTop: 0 };
      const targetIndex = clamp(target.paragraphIndex ?? 0, 0, Math.max(chapter.paragraphCount - 1, 0));
      const indexes = Array.from(
        { length: Math.min(chapter.paragraphCount, targetIndex + 7) - Math.max(0, targetIndex - 6) },
        (_, index) => Math.max(0, targetIndex - 6) + index,
      );
      const cache = pagesRef.current;
      // Failed loads are deliberately sticky in the shared cache. Only explicit retry clears them.
      if (openAttempt > 0) {
        await Promise.all(
          [...new Set(indexes.map((index) => Math.floor(index / PARAGRAPHS_PER_PAGE)))]
            .filter((index) => cache.isPageFailed(index))
            .map((index) => cache.retryPage(index)),
        );
      }
      await loadParagraphIndexes(indexes);
      if (cancelled) return;
      if (chapter.paragraphCount > 0 && !cache.paragraphAt(targetIndex)) throw new Error('Resume target unavailable');
      if (target.paragraphIndex !== undefined && chapter.paragraphCount > 0) {
        const paragraph = cache.paragraphAt(targetIndex)!;
        const anchor: ReaderAnchor = {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: targetIndex,
          offset: explicitParagraph ? 0 : (openRequest.position?.offsetInParagraph ?? 0),
        };
        if (!(await apiRef.current?.scrollToAnchor(anchor, 0, openRequest.preserveSearch ? 'search' : undefined)))
          throw new Error('Resume layout unavailable');
        if (cancelled) return;
        // Load the destination viewport as well as its overscan before revealing it.
        await loadParagraphIndexes(virtualizer.getVirtualItems().map((item) => item.index));
        if (cancelled) return;
        if (!(await apiRef.current?.scrollToAnchor(anchor, 0, openRequest.preserveSearch ? 'search' : undefined)))
          throw new Error('Resume layout unavailable');
      } else if (rootRef.current) {
        const navigation = beginNavigation();
        await nextFrame();
        if (cancelled || !isCurrentNavigation(navigation)) return;
        rootRef.current.scrollTop = target.canRestore ? target.scrollTop : openRequest.fallbackScrollTop;
        await nextFrame();
        await loadParagraphIndexes(virtualizer.getVirtualItems().map((item) => item.index));
      }
      await nextFrame();
      if (!cancelled) setAppliedOpenSequence(openRequest.sequence);
    };
    void restore().catch(() => {
      if (!cancelled) setOpenError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    apiRef,
    beginNavigation,
    chapter,
    isActive,
    isCurrentNavigation,
    loadParagraphIndexes,
    novel.activeContentRevisionId,
    novel.id,
    openAttempt,
    opening,
    openRequest,
    repository,
    virtualizer,
  ]);

  useEffect(() => {
    if (opening || !isActive || !openRequest || appliedOpenSequence !== openRequest.sequence) return;
    screenHandle.acknowledgeOpen(openRequest.sequence);
    // Only the restored, visible viewport may publish or persist a reading position.
    recordVisibleLocation();
  }, [appliedOpenSequence, isActive, openRequest, opening, recordVisibleLocation, screenHandle]);

  const failedRows = new Set<number>();
  const failedPages = new Set<number>();
  for (const item of virtualItems) {
    const pageIndex = Math.floor(item.index / PARAGRAPHS_PER_PAGE);
    if (pages.isPageFailed(pageIndex) && !failedPages.has(pageIndex)) {
      failedPages.add(pageIndex);
      failedRows.add(item.index);
    }
  }

  const previousNativeOffset = useRef(0);
  const preparePreviousChapter = () => {
    if (sequence && !opening && isActive && (virtualizer.range?.startIndex ?? 0) <= 12) void sequence.prepare(-1);
  };
  const actionHandlers = {
    previousPage: () => onPageIntent(-1),
    nextPage: () => onPageIntent(1),
    toggleChrome: onToggleImmersive,
    openToc: () => screenHandle.getActions().openAddon('outline'),
    openSettings: () => screenHandle.getActions().openSettings(),
    toggleTTS: () => screenHandle.getActions().toggleTTS(progress.readLocation()?.ttsIndex ?? 0),
  };
  const gestureHandlers = useReaderGestureHandlers({
    bindings: { ...settings.gestureBindings, tapCenter: 'toggle_chrome' },
    viewportWidth: () => rootRef.current?.clientWidth ?? window.innerWidth,
    actions: actionHandlers,
    onVerticalScrollIntent: scrollChapterBoundary.onVerticalGesture,
  });

  return (
    <>
      <div ref={autoOverlayRef} className="reader-auto-reading-overlay" aria-hidden="true" hidden />
      {isActive && opening && (
        <div className="reader-opening" role={openError ? 'alert' : 'status'}>
          <p>{openError ? '읽던 위치를 불러오지 못했습니다.' : '본문을 준비하고 있습니다…'}</p>
          {openError && (
            <button className="ghost-btn" onClick={() => setOpenAttempt((attempt) => attempt + 1)}>
              다시 시도
            </button>
          )}
        </div>
      )}
      <section
        ref={rootRef}
        className={`reader-scroll reader-viewport-layer ${isActive ? 'is-active' : pageLayer ? 'is-page-host' : 'is-inactive'} ${opening && isActive ? 'is-opening' : ''} ${scrollChapterBoundary.armed ? 'is-next-chapter-armed' : ''} font-${settings.font} mode-${mode}`}
        tabIndex={isActive ? 0 : -1}
        aria-hidden={!isActive && !pageLayer}
        aria-busy={opening}
        data-reader-layer="scroll"
        onScroll={() => {
          if (!isActive) {
            if (nativeScrollReady && preparedHandoff.current) {
              // Ignored input (e.g. browser Ctrl-wheel) can still move a native
              // scroller. A measurement rebase is harmless only if its glyph stays put.
              const { anchor, offset } = preparedHandoff.current;
              const element = [
                ...(documentRef.current?.querySelectorAll<HTMLElement>('[data-paragraph-id]') ?? []),
              ].find((element) => element.dataset.paragraphId === anchor.blockId);
              const range = element && sourceRange(element, anchor.offset, anchor.offset + 1);
              if (
                range &&
                rootRef.current &&
                Math.abs(range.getBoundingClientRect().top - readerContentTop(rootRef.current) - offset) > 1
              ) {
                if (nativeInput.current) enterNativeScroll();
                else onScrollHandoffInvalidated?.();
              }
            }
            return;
          }
          if (opening) return;
          releaseUnusedHandoffSpace();
          const top = rootRef.current?.scrollTop ?? 0;
          if (top < previousNativeOffset.current - 2) preparePreviousChapter();
          previousNativeOffset.current = top;
          onRevealChrome();
          progress.handleScroll();
          scrollChapterBoundary.onScroll();
        }}
        onTouchStartCapture={(event) => {
          nativeInput.current = Boolean(nativeScrollReady);
          const touch = event.touches[0];
          nativeTouch.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : undefined;
        }}
        onTouchMoveCapture={(event) => {
          const start = nativeTouch.current,
            touch = event.touches[0];
          if (isActive && start && touch && touch.clientY > start.y + 10 && event.touches.length === 1)
            preparePreviousChapter();
          if (isActive || !nativeScrollReady || !start || event.touches.length !== 1 || !touch) return;
          const dy = Math.abs(touch.clientY - start.y),
            dx = Math.abs(touch.clientX - start.x);
          if (
            dy > 10 &&
            dy > dx &&
            !window.getSelection()?.toString() &&
            !rootRef.current?.querySelector('[data-turn-phase]')
          ) {
            nativeInput.current = true;
            enterNativeScroll();
          }
        }}
        onTouchEndCapture={() => {
          nativeTouch.current = undefined;
          if (!isActive) nativeInput.current = false;
        }}
        onTouchCancelCapture={() => {
          nativeTouch.current = undefined;
          if (!isActive) nativeInput.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (event.target === event.currentTarget && ['ArrowUp', 'PageUp', 'Home'].includes(event.key))
            preparePreviousChapter();
        }}
        onWheelCapture={(event) => {
          if (!event.ctrlKey && event.deltaY < 0) preparePreviousChapter();
          if (!isActive && nativeScrollReady && !event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX))
            enterNativeScroll();
        }}
        onWheel={scrollChapterBoundary.onWheel}
        onKeyUp={updateSelection}
        onMouseUp={updateSelection}
        onTouchEnd={updateSelection}
        onPointerDown={(event) => {
          if (!isActive) return;
          const shouldCaptureBoundaryGesture = scrollChapterBoundary.onPointerDown(
            event.clientY,
            event.pointerType,
            event.target,
          );
          gestureHandlers.onPointerDown(event);
          if (shouldCaptureBoundaryGesture) {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Synthetic pointer events do not own an active pointer, but the gesture can still be handled.
            }
          }
        }}
        onPointerMove={(event) => {
          if (scrollChapterBoundary.onPointerMove(event.clientY, event.pointerType)) event.preventDefault();
        }}
        onPointerUp={(event) => {
          if (!isActive) return;
          gestureHandlers.onPointerUp(event);
          scrollChapterBoundary.onPointerEnd();
        }}
        onPointerCancel={scrollChapterBoundary.onPointerEnd}
        onClick={(event) => event.stopPropagation()}
      >
        {pageLayer}
        <article
          aria-hidden={!isActive}
          ref={documentRef}
          className="reader-document"
          style={searchInset > 0 ? { marginTop: searchInset } : undefined}
        >
          {sequence && (
            <ReaderChapterLead
              unit="화"
              status={
                sequence.status(-1) === 'ready'
                  ? 'idle'
                  : sequence.status(-1) === 'end'
                    ? 'start'
                    : (sequence.status(-1) as 'loading' | 'error')
              }
              onRetry={() => void sequence.prepare(-1, true)}
            />
          )}
          <ReaderChapterHeading chapter={sequence?.first ?? chapter} />
          <div
            className="reader-virtual-list"
            style={{
              height: scrollPosition.preserveNativeRange(
                Math.max(0, virtualizer.getTotalSize() - scrollPosition.shift),
                Boolean(sequence && structuralAnchor.current && structuralAnchor.current.shape !== sequenceShape),
              ),
            }}
          >
            {virtualItems.map((item) => {
              const row = localRow(item.index);
              if (row?.boundary) {
                const at = sequence!.entries.indexOf(row.entry);
                const next = sequence!.entries[at + 1]?.chapter;
                return (
                  <div
                    key={sequence!.key(item.index)}
                    ref={measureVirtualRow}
                    data-index={item.index}
                    className="reader-virtual-row"
                    style={{ transform: `translateY(${item.start - listOffset - scrollPosition.shift}px)` }}
                  >
                    <ReaderChapterSeparator
                      unit="화"
                      currentTitle={row.entry.chapter.title}
                      nextTitle={next?.title}
                      status={next ? 'ready' : sequence!.status(1)}
                      onRetry={() => void sequence!.prepare(1, true)}
                    />
                  </div>
                );
              }
              const paragraph = pages.paragraphAt(item.index);
              if (!paragraph) {
                const pageIndex = Math.floor(item.index / PARAGRAPHS_PER_PAGE);
                const failed = failedRows.has(item.index);
                return (
                  <div
                    key={`${failed ? 'failed' : 'loading'}-${item.index}`}
                    ref={failed ? measureVirtualRow : undefined}
                    data-index={item.index}
                    className="reader-virtual-row"
                    // Evicted text keeps its measured size while it reloads. Measuring the
                    // short skeleton overwrites that size and shifts every later paragraph.
                    style={{
                      transform: `translateY(${item.start - listOffset - scrollPosition.shift}px)`,
                      height: failed ? undefined : item.size,
                    }}
                  >
                    {failed ? (
                      <div className="reader-paragraph is-error" role="alert">
                        <p>본문을 불러오지 못했습니다.</p>
                        <button type="button" className="ghost-btn" onClick={() => void pages.retryPage(pageIndex)}>
                          다시 시도
                        </button>
                      </div>
                    ) : (
                      <div className="reader-paragraph is-loading" aria-hidden="true">
                        <p />
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <ReaderParagraphRow
                  key={paragraph.id}
                  paragraph={paragraph}
                  flowBreaks={flowBreaks?.[paragraph.id]}
                  virtualIndex={item.index}
                  start={item.start - listOffset - scrollPosition.shift}
                  estimatedSize={item.size}
                  isSpeaking={
                    sequence
                      ? ttsParagraphId
                        ? paragraph.id === ttsParagraphId
                        : row?.entry.chapter.id === activeChapter.id && row?.localIndex === ttsIndex
                      : ttsIndex === item.index
                  }
                  mode={mode}
                  searchQuery={search.highlightQuery}
                  decorationStore={screenHandle.decorations}
                  measureElement={measureVirtualRow}
                  onSelectCorrectionSegment={selectCorrectionSegment}
                  assetRepository={assetRepository}
                  onDocumentLink={onDocumentLink}
                />
              );
            })}
          </div>
          {!continuous && (
            <ReaderChapterEnd
              unit="화"
              nextTitle={nextChapter ? `${nextChapter.index}화 · ${nextChapter.title}` : undefined}
              hasPrevious={chapter.index > 1}
              armed={scrollChapterBoundary.armed}
              busy={navigationBusy}
              rootProps={{
                'data-scroll-chapter-boundary': nextChapter ? 'true' : 'false',
                'data-scroll-chapter-boundary-armed': scrollChapterBoundary.armed ? 'true' : 'false',
              }}
              onPrevious={() => void goChapter(-1)}
              onNext={() => void goChapter(1)}
            />
          )}
          <div
            ref={handoffSpaceRef}
            aria-hidden="true"
            style={{ height: 0, overflow: 'hidden', overflowAnchor: 'none' }}
          />
        </article>
      </section>
    </>
  );
}

function ReaderViewportComponent(props: ReaderViewportProps) {
  const positionPersistence = useMemo(() => sharedReaderPositionPersistence(props.repository), [props.repository]);
  const { apiRef: outerApiRef, onApiReady: notifyApiReady, onVisualLocation, novel, chapter } = props;
  const modeLock = props.settings.readingProfile.modeLock;
  const [paginationFailed, setPaginationFailed] = useState(false);
  const [paginationMounted, setPaginationMounted] = useState(props.readingFlow === 'paginated');
  const [scrollApiReady, setScrollApiReady] = useState(false);
  const [pageApiReady, setPageApiReady] = useState(false);
  const scrollApiRef = useRef<ReaderViewportApi>();
  const pageApiRef = useRef<ReaderViewportApi>();
  const scrollApi = useMemo(() => createViewportApiProxy(scrollApiRef, 'scroll'), []);
  const stackRef = useRef<HTMLDivElement>(null);
  const flowAnimation = useRef<AbortController>();
  const motionRef = useRef(props.settings.readingProfile.pageTurnMotion);
  motionRef.current = props.settings.readingProfile.pageTurnMotion;
  const pageApi = useMemo(
    () => ({
      ...createViewportApiProxy(pageApiRef, 'paginated'),
      animateFlowEntry: async (direction: -1 | 1, signal: AbortSignal) => {
        flowAnimation.current?.abort();
        const controller = new AbortController();
        flowAnimation.current = controller;
        const cancel = () => controller.abort();
        signal.addEventListener('abort', cancel, { once: true });
        window.addEventListener('resize', cancel);
        window.addEventListener('blur', cancel);
        try {
          if (stackRef.current && !signal.aborted)
            await animateReaderFlow(
              stackRef.current,
              motionRef.current,
              direction,
              controller.signal,
              pageApiRef.current?.getAnchor(),
            );
        } finally {
          signal.removeEventListener('abort', cancel);
          window.removeEventListener('resize', cancel);
          window.removeEventListener('blur', cancel);
        }
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!props.pageTransitionPending) flowAnimation.current?.abort();
  }, [props.pageTransitionPending]);
  useEffect(() => () => flowAnimation.current?.abort(), []);
  const handlePaginationFailure = useCallback(() => setPaginationFailed(true), []);
  const handleScrollApiReady = useCallback((api?: ReaderViewportApi) => setScrollApiReady(Boolean(api)), []);
  const handlePageApiReady = useCallback((api?: ReaderViewportApi) => setPageApiReady(Boolean(api)), []);
  const paginationProfileKey = JSON.stringify(props.settings.readingProfile);
  // A failed page preparation falls back to scroll. A later explicit mode
  // entry is a new attempt, rather than a permanently disabled page layer.
  useEffect(() => setPaginationFailed(false), [props.chapter.id, paginationProfileKey, props.readingFlow]);
  useEffect(() => {
    if (props.readingFlow === 'paginated') setPaginationMounted(true);
  }, [props.readingFlow]);
  const pageActive = props.readingFlow === 'paginated' && !paginationFailed;
  const [nativeScrollReady, setNativeScrollReady] = useState(false);
  const nativeSync = useRef(0);
  const nativeReady = useRef(false);
  useEffect(
    () => () => {
      nativeSync.current++;
      nativeReady.current = false;
    },
    [],
  );
  const syncedAnchor = useRef<string>();
  const syncedLocation = useRef<string>();
  const preparedPlan = useRef<{ anchor: ReaderAnchor; offset: number; breaks?: ReaderFlowBreaks }>();
  const anchorKey = (anchor: ReaderAnchor) =>
    JSON.stringify([anchor.sectionId, anchor.blockId, anchor.blockIndex, anchor.offset]);
  const prepareNativeScroll = useCallback(
    async (anchor: ReaderAnchor, offset: number, breaks?: ReaderFlowBreaks, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      if (modeLock === 'paginated') return;
      const key = JSON.stringify([anchorKey(anchor), offset, breaks]);
      if (syncedAnchor.current === key && nativeReady.current) return;
      const generation = ++nativeSync.current;
      nativeReady.current = false;
      setNativeScrollReady(false);
      const restored = await scrollApiRef.current?.prepareScrollHandoff?.(anchor, offset, breaks, signal);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      if (generation !== nativeSync.current) return;
      // Interrupted preparations must remain retryable at this same anchor.
      const ready = Boolean(restored && !signal?.aborted);
      syncedAnchor.current = ready ? key : undefined;
      syncedLocation.current = ready ? anchorKey(anchor) : undefined;
      if (ready) preparedPlan.current = { anchor, offset, breaks };
      nativeReady.current = ready;
      setNativeScrollReady(ready);
    },
    [modeLock],
  );
  const handlePageLocation = useCallback(
    (location: ReaderLocationSnapshot) => {
      onVisualLocation(location);
      const anchor: ReaderAnchor = {
        bookId: novel.id,
        contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
        sectionId: chapter.id,
        blockId: location.paragraph?.id ?? '',
        blockIndex: Math.max(0, location.paragraphIndex - 1),
        offset: location.offsetInParagraph ?? 0,
      };
      if (syncedLocation.current === anchorKey(anchor) && nativeReady.current) return;
      const pageRoot = stackRef.current?.querySelector<HTMLElement>('[data-reader-layer="paginated"]');
      const article = pageRoot?.querySelector<HTMLElement>('.reader-paginated-page.is-current');
      const firstParagraph = article?.querySelector<HTMLElement>('[data-paragraph-id]');
      const line = firstParagraph && sourceRange(firstParagraph, 0, 1)?.getBoundingClientRect();
      // Relative to the article, a translated smooth page contributes no offset.
      const offset = article && line ? line.top - article.getBoundingClientRect().top : 0;
      const lastParagraph = [...(article?.querySelectorAll<HTMLElement>('[data-paragraph-id]') ?? [])].at(-1);
      const breaks: Record<string, number[]> = { [anchor.blockId]: [anchor.offset] };
      const lastId = lastParagraph?.dataset.paragraphId;
      if (lastId) (breaks[lastId] ??= []).push(Number(article?.dataset.pageEndOffset ?? 0));
      void prepareNativeScroll(anchor, offset, breaks).catch(() => undefined);
    },
    [onVisualLocation, novel.id, novel.activeContentRevisionId, chapter.id, prepareNativeScroll],
  );
  useLayoutEffect(() => {
    nativeSync.current++;
    nativeReady.current = false;
    syncedAnchor.current = undefined;
    syncedLocation.current = undefined;
    preparedPlan.current = undefined;
    setNativeScrollReady(false);
  }, [pageActive, props.chapter.id, props.novel.activeContentRevisionId, paginationProfileKey]);

  useLayoutEffect(() => {
    const selected = pageActive ? (pageApiReady ? pageApi : undefined) : scrollApiReady ? scrollApi : undefined;
    outerApiRef.current = selected;
    notifyApiReady(selected);
    return () => {
      if (outerApiRef.current === selected) outerApiRef.current = undefined;
    };
  }, [notifyApiReady, outerApiRef, pageActive, pageApi, pageApiReady, scrollApi, scrollApiReady]);
  useEffect(
    () => () => {
      outerApiRef.current = undefined;
      notifyApiReady(undefined);
    },
    [notifyApiReady, outerApiRef],
  );
  return (
    <div className="reader-viewport-stack" ref={stackRef}>
      <VirtualizedReaderViewportComponent
        {...props}
        apiRef={scrollApiRef}
        onApiReady={handleScrollApiReady}
        isActive={!pageActive}
        positionPersistence={positionPersistence}
        nativeScrollReady={pageActive && nativeScrollReady && !props.navigationBusy && !props.pageTransitionPending}
        onScrollHandoffInvalidated={() => {
          const plan = preparedPlan.current;
          if (!nativeReady.current || !plan) return;
          syncedAnchor.current = undefined;
          void prepareNativeScroll(plan.anchor, plan.offset, plan.breaks).catch(() => undefined);
        }}
        onNativeScroll={() => {
          if (nativeReady.current) props.onNativeScrollIntent?.();
        }}
        pageLayer={
          (paginationMounted || props.readingFlow === 'paginated') && !paginationFailed ? (
            <PaginatedReaderViewport
              {...props}
              apiRef={pageApiRef}
              onApiReady={handlePageApiReady}
              isActive={pageActive}
              positionPersistence={positionPersistence}
              onPaginationFailure={handlePaginationFailure}
              onVisualLocation={handlePageLocation}
              onPrepareNativeScroll={prepareNativeScroll}
              initialAnchor={scrollApiRef.current?.getAnchor()}
              nativeScrollReady={nativeScrollReady && !props.navigationBusy && !props.pageTransitionPending}
            />
          ) : undefined
        }
      />
    </div>
  );
}

export const ReaderViewport = memo(ReaderViewportComponent);
