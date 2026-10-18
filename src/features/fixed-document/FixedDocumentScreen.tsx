import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { createDocumentTextStore } from '../../storage/document-text-store';
import { comicCropKey } from './comic-crop-key';
import { useSourceComicLayout, type SourceComicLayoutState } from './use-source-comic-layout';
import { usePdfTextSession } from './use-pdf-text-session';
import { usePdfTextSearch } from './use-pdf-text-search';
import { usePdfOcrController } from './use-pdf-ocr-controller';
import { usePdfReadingOrder } from './use-pdf-reading-order';
import { pdfPageHash, pdfTextScope } from './text/pdf-text-publication';
import { PdfPageView, type PdfTextSelection, type PdfRegionSelection } from './PdfPageView';
import { streamImageWindow } from './stream-image-window';
import type { ComicViewportPosition } from './use-comic-viewport-position';
import { AutoScrollControls } from '../reader/AutoScrollControls';
import { useComicAutoReading } from './use-comic-auto-reading';
import { renewViewportFocalRestore, scheduleViewportFocalRestore } from './viewport-focal-restore';

import { useFixedDocumentNavigation, clampFixedDocumentPage as clampPage } from './use-fixed-document-navigation';
import { usePdfDocumentSession } from './use-pdf-document-session';
import { useComicPageFlow } from './use-comic-page-flow';
import { useComicPageSizes } from './use-comic-page-sizes';
import { ComicPageFlow } from './ComicPageFlow';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  EyeOff,
  Expand,
  Highlighter,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCw,
  RefreshCw,
  Search,
  Settings2,
  StickyNote,
  TextCursorInput,
  X,
} from 'lucide-react';
import { persistentId128 } from '@boaa/text-core/hash';
import { useFixedDocumentReadingPosition } from './use-fixed-document-reading-position';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PDFPageProxy } from 'pdfjs-dist';
import type {
  Chapter,
  BookAssetMetadata,
  ComicReadingProfile,
  DocumentAnnotation,
  ListeningPosition,
  Novel,
  ReadingPosition,
} from '../../domain/types';
import { bookFormatLabel } from '../../domain/book-format';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { IndexedDbDocumentAnnotationRepository } from '../../storage/document-annotation-store';
import type { DocumentAnnotationRepository } from '../../repositories/document-annotation-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { useScrollChapterBoundary } from '../reader/use-scroll-chapter-boundary';

import { IndexedDbComicReadingProfileRepository } from '../../storage/comic-reading-profile-store';
import {
  getDocumentThumbnail,
  pruneDocumentThumbnails,
  saveDocumentThumbnail,
} from '../../storage/document-thumbnail-store';
import { OCR_LANGUAGE_MODELS, type OcrLanguageModel } from './ocr/ocr-language-model-cache';
import {
  archiveFullImageWindow,
  archivePageSourceIdentity,
  archiveThumbnailFingerprint,
  archiveThumbnailPageHash,
  renderArchiveThumbnail,
} from './archive-thumbnail';
import { renderPdfGeneratedCover } from './pdf-generated-cover';
import { pdfThumbnailFingerprint, renderPdfThumbnail } from './pdf-thumbnail';
import { runDocumentThumbnailBatch, type DocumentThumbnailBatchProgress } from './document-thumbnail-batch';
import { fixedDocumentSidebarStartsOpen } from './fixed-document-responsive';
import { manuallyReanchorFixedTextAnnotation } from './text/manual-fixed-text-reanchor';
import {
  buildComicSpreads,
  comicProfileModeToViewMode,
  comicSpreadForPage,
  comicSpreadPages,
  comicViewModeToProfileMode,
  DEFAULT_COMIC_READING_PROFILE,
  isContinuousComicViewMode,
  type ComicViewMode,
  type ComicPageLayoutHint,
} from './comic-layout';
import { comicCropRefitScale, detectComicContentBounds, runComicAutoCropBatch } from './comic-auto-crop';
import { captureViewportFocalAnchor, type PageFocalRect, type ViewportFocalAnchor } from './viewport-focal-anchor';
import {
  continuousComicPageIndexes,
  continuousComicSectionIndex,
  continuousPageNearestViewportCenter,
  shouldAnchorContinuousPageResize,
  type ContinuousImageDimensions,
} from './continuous-scroll';
import { fixedDocumentSeekWindow, projectFixedDocumentSections } from './fixed-document-sections';
import { useArchivePageImages } from './use-archive-page-images';
import {
  fixedDocumentPanAxis,
  fixedDocumentTapStep,
  handleFixedDocumentKeyDown,
  isFixedDocumentInteractiveTarget,
  parseFixedDocumentPageDraft,
  type FixedDocumentPanAxis,
} from './fixed-document-input';
import './fixed-document.css';
import { uiNextKitClass } from '../../ui-next/app-presentation';
const UiNextComicSettings = lazy(() =>
  import('../../ui-next/reader/UiNextComicSettings').then((module) => ({ default: module.UiNextComicSettings })),
);
import '../../ui-next/styles/tokens.css';
import '../../ui-next/styles/kit.css';
import '../../ui-next/reader/document.css';

type FitMode = ComicReadingProfile['fit'];
type ViewMode = ComicViewMode;

const CONTINUOUS_SECTION_NAV_HEIGHT = 112;
const CONTINUOUS_SECTION_BOUNDARY_HEIGHT = 196;

const OCR_LANGUAGE_LABELS: Record<OcrLanguageModel, string> = {
  kor: '한국어',
  jpn: '일본어',
  eng: '영어',
};

function formatStoredBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function mobileComicSectionLabel(title: string): string {
  const normalized = title.trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? `${normalized}화` : normalized;
}

export interface ComicRemoteNavigation {
  readonly invalidatePage?: (index: number) => void;
  readonly scope: string;
  readonly nextScope: string;
  readonly nextTitle?: string;
  readonly error?: string;
  readonly retry?: () => void;
  readonly busy?: boolean;
  readonly prefetchPages: number;
  readonly profileKey: string;
  readonly initialPosition?: ComicViewportPosition;
  readonly savePosition?: (position: ComicViewportPosition) => void;
  readonly previous?: (isCurrent?: () => boolean) => Promise<void>;
  readonly next?: (isCurrent?: () => boolean) => Promise<void>;
}

export interface FixedDocumentScreenProps {
  /** Image loading is held until the profile is applied. No UI rendering is prescribed. */
  readonly onLayoutReadyChange?: (layoutReady: boolean) => void;
  readonly onLayoutStateChange?: (state: SourceComicLayoutState) => void;
  readonly remoteNavigation?: ComicRemoteNavigation;
  readonly novel: Novel;
  readonly chapters: readonly Chapter[];
  readonly readingPosition?: ReadingPosition;
  readonly initialChapterId?: string;
  readonly entryRequestVersion?: number;
  readonly repository: Pick<ReaderRepository, 'getParagraphPage'>;
  readonly assets: Pick<BookAssetRepository, 'getEmbeddedResource' | 'openSource' | 'saveGeneratedCover'>;
  readonly onBack: () => void;
  readonly onPageSettled: (
    pageIndex: number,
    chapter: Chapter,
    novel: Novel,
    position?: ComicViewportPosition,
  ) => void | Promise<void>;
  readonly onGeneratedCover?: (cover: BookAssetMetadata) => void;
  readonly onStartListening?: (pageIndex: number, blockId?: string, startOffset?: number) => void | Promise<void>;
  readonly onPrepareListening?: (startPageIndex: number, endPageIndex: number) => void | Promise<void>;
  readonly onCancelListeningPreparation?: () => void;
  readonly listeningPreparationBusy?: boolean;
  readonly listeningPosition?: ListeningPosition;
  readonly annotationSyncRevision?: string;
  readonly documentAnnotationRepository?: DocumentAnnotationRepository;
}

function comicPageTypeLabel(type?: string): string | undefined {
  switch (type?.trim().toLocaleLowerCase()) {
    case 'frontcover':
      return '표지';
    case 'backcover':
      return '뒤표지';
    case 'story':
      return '본문';
    case 'advertisement':
      return '광고';
    case 'deleted':
      return '삭제 표기';
    default:
      return type?.trim() || undefined;
  }
}

async function detectComicCrop(image: Blob) {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('이미지 분석 화면을 만들 수 없습니다.');
    context.drawImage(bitmap, 0, 0, width, height);
    return detectComicContentBounds(context.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bitmap.close();
  }
}

function PdfThumbnailPreview({
  page,
  bookId,
  pageIndex,
  pageHash,
}: {
  readonly page: PDFPageProxy;
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const renderFingerprint = pdfThumbnailFingerprint();
      const cached = await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint });
      let blob = cached?.blob;
      if (!blob) {
        const rendered = await renderPdfThumbnail(page, controller.signal);
        blob = rendered.blob;
        await saveDocumentThumbnail({
          bookId,
          pageIndex,
          pageHash,
          renderFingerprint: rendered.renderFingerprint,
          contentType: rendered.contentType,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
          blob,
        }).catch(() => undefined);
        void pruneDocumentThumbnails(bookId).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, page, pageHash, pageIndex]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}

function ArchiveThumbnailPreview({
  bookId,
  sourceIdentity,
  chapterId,
  pageIndex,
  repository,
  assets,
  onPageHint,
  persistent = true,
}: {
  readonly persistent?: boolean;
  readonly bookId: string;
  readonly sourceIdentity: string;
  readonly chapterId: string;
  readonly pageIndex: number;
  readonly repository: Pick<ReaderRepository, 'getParagraphPage'>;
  readonly assets: Pick<BookAssetRepository, 'getEmbeddedResource' | 'openSource' | 'saveGeneratedCover'>;
  readonly onPageHint: (pageIndex: number, hint: ComicPageLayoutHint) => void;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const paragraphPage = await repository.getParagraphPage(chapterId, 0, controller.signal);
      const paragraph = paragraphPage?.paragraphs[0];
      if (paragraph?.documentPageType !== undefined || paragraph?.documentPageDouble !== undefined) {
        onPageHint(pageIndex, {
          type: paragraph.documentPageType,
          doublePage: paragraph.documentPageDouble,
        });
      }
      const assetId = paragraph?.assetId;
      if (!assetId) throw new Error('이미지 페이지 정보를 찾을 수 없습니다.');
      const pageHash = archiveThumbnailPageHash(assetId, pageIndex);
      const renderFingerprint = archiveThumbnailFingerprint();
      const cached = persistent
        ? await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint })
        : undefined;
      let blob = cached?.blob;
      if (!blob) {
        const resource = await assets.getEmbeddedResource(bookId, assetId, controller.signal);
        if (!resource) throw new Error('이미지 페이지를 찾을 수 없습니다.');
        const rendered = await renderArchiveThumbnail(resource.blob, controller.signal);
        blob = rendered.blob;
        controller.signal.throwIfAborted();
        if (persistent) {
          await saveDocumentThumbnail({
            bookId,
            pageIndex,
            pageHash,
            renderFingerprint: rendered.renderFingerprint,
            contentType: rendered.contentType,
            pixelWidth: rendered.pixelWidth,
            pixelHeight: rendered.pixelHeight,
            blob,
          }).catch(() => undefined);
          void pruneDocumentThumbnails(bookId).catch(() => undefined);
        }
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assets, bookId, chapterId, onPageHint, pageIndex, repository, sourceIdentity, persistent]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}

export default function FixedDocumentScreen({
  remoteNavigation,
  novel,
  chapters,
  readingPosition,
  initialChapterId,
  entryRequestVersion,
  onLayoutReadyChange,
  onLayoutStateChange,
  repository,
  assets,
  onBack,
  onPageSettled,
  onGeneratedCover,
  onStartListening,
  onPrepareListening,
  onCancelListeningPreparation,
  listeningPreparationBusy = false,
  listeningPosition,
  annotationSyncRevision,
  documentAnnotationRepository: providedDocumentAnnotationRepository,
}: FixedDocumentScreenProps) {
  const auxiliaryDatabase = useOptionalAppRuntime()?.readerRuntime.auxiliaryDatabase;
  const documentTextRepository = useMemo(
    () => new (createDocumentTextStore(auxiliaryDatabase).IndexedDbDocumentTextRepository)(),
    [auxiliaryDatabase],
  );
  const documentAnnotationRepository = useMemo(
    () => providedDocumentAnnotationRepository ?? new IndexedDbDocumentAnnotationRepository(auxiliaryDatabase),
    [providedDocumentAnnotationRepository, auxiliaryDatabase],
  );
  const comicReadingProfileRepository = useMemo(
    () => new IndexedDbComicReadingProfileRepository(auxiliaryDatabase),
    [auxiliaryDatabase],
  );
  const persistThumbnails = !remoteNavigation;
  const sortedChapters = useMemo(() => [...chapters].sort((left, right) => left.index - right.index), [chapters]);
  const documentSections = useMemo(
    () => projectFixedDocumentSections(novel.id, sortedChapters),
    [novel.id, sortedChapters],
  );
  const totalPages = sortedChapters.length;
  const { pageIndex, pageDraft, goToPage, observePage, setPageDraft } = useFixedDocumentNavigation({
    bookId: novel.id,
    chapters: sortedChapters,
    readingPosition,
    initialChapterId,
    entryRequestVersion,
    listeningPosition,
    onNavigate: (normalized) => {
      if (!continuousView) return;
      const virtualIndex = continuousVirtualIndexByPage.get(normalized);
      if (virtualIndex === undefined) pendingContinuousPageRef.current = normalized;
      else if (stableComicFlow) scrollComicFlowToPage(normalized);
      else continuousVirtualizer.scrollToIndex(virtualIndex, { align: seamlessContinuousView ? 'start' : 'center' });
    },
  });
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    fixedDocumentSidebarStartsOpen(typeof window === 'undefined' ? 1_280 : window.innerWidth),
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileThumbnailOpen, setMobileThumbnailOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fit, setFit] = useState<FitMode>('page');
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [pageTurnDirection, setPageTurnDirection] = useState<-1 | 1>();
  const pageTurnTimerRef = useRef<number>();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [imageDimensions, setImageDimensions] = useState<Map<string, ContinuousImageDimensions>>(() => new Map());
  const [navigationError, setNavigationError] = useState('');
  useEffect(() => setNavigationError(''), [novel.id]);
  const viewportRef = useRef<HTMLElement>(null);
  const continuousContentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1000, height: 800 });
  const viewportSizeRef = useRef(viewportSize);
  const viewportMeasuredRef = useRef(false);
  const viewportScrollFrameRef = useRef<number>();
  const pendingContinuousPageRef = useRef<number>();
  const [focalRestoreRevision, setFocalRestoreRevision] = useState(0);
  const pointerStartRef = useRef<{ x: number; y: number; at: number; immersiveEligible: boolean }>();
  const pointerPanAxisRef = useRef<FixedDocumentPanAxis>();
  const suppressViewportClickRef = useRef(false);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    zoom: number;
    active: boolean;
    anchor?: ViewportFocalAnchor;
  }>();
  const pendingFocalAnchorRef = useRef<ViewportFocalAnchor>();
  const comicCropControllerRef = useRef<AbortController>();
  const generatedCoverAttemptRef = useRef<string>();
  const thumbnailBatchControllerRef = useRef<AbortController>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [listeningPreparationOpen, setListeningPreparationOpen] = useState(false);
  const [listeningRangeStart, setListeningRangeStart] = useState(pageIndex + 1);
  const [listeningRangeEnd, setListeningRangeEnd] = useState(Math.min(totalPages, pageIndex + 10));
  const [comicSettingsOpen, setComicSettingsOpen] = useState(false);
  const [autoReadingOpen, setAutoReadingOpen] = useState(false);
  const [comicProfile, setComicProfile] = useState<ComicReadingProfile>(DEFAULT_COMIC_READING_PROFILE);
  const [comicPageHints, setComicPageHints] = useState<Map<number, ComicPageLayoutHint>>(() => new Map());
  const [comicCropStatus, setComicCropStatus] = useState<'idle' | 'running' | 'failed'>('idle');
  const [comicCropProgress, setComicCropProgress] = useState<{ current: number; total: number; detected: number }>();
  const [comicCropFailedPages, setComicCropFailedPages] = useState(0);
  const [thumbnailBatchProgress, setThumbnailBatchProgress] = useState<DocumentThumbnailBatchProgress>();
  const [thumbnailBatchSummary, setThumbnailBatchSummary] = useState<{
    readonly rendered: number;
    readonly failed: number;
    readonly cancelled: boolean;
  }>();
  const [documentAnnotations, setDocumentAnnotations] = useState<DocumentAnnotation[]>([]);
  const [pendingTextSelection, setPendingTextSelection] = useState<PdfTextSelection>();
  const [reanchorTargetId, setReanchorTargetId] = useState<string>();
  const [selectionNoteDraft, setSelectionNoteDraft] = useState('');
  const [pendingRegionSelection, setPendingRegionSelection] = useState<PdfRegionSelection>();
  const [regionNoteDraft, setRegionNoteDraft] = useState('');

  const requestedViewMode =
    novel.format !== 'image_archive' && viewMode === 'continuous-seamless' ? 'continuous' : viewMode;
  const effectiveViewMode: ViewMode =
    requestedViewMode === 'spread' && viewportSize.width < 720 ? 'single' : requestedViewMode;
  const continuousView = isContinuousComicViewMode(effectiveViewMode);
  const seamlessContinuousView = effectiveViewMode === 'continuous-seamless';

  const captureFocalAnchor = useCallback(
    (clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return undefined;
      const viewportRect = viewport.getBoundingClientRect();
      const pages = [...viewport.querySelectorAll<HTMLElement>('[data-page-index]')].map<PageFocalRect>((element) => {
        const rect = element.getBoundingClientRect();
        return {
          pageIndex: Number(element.dataset.pageIndex),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
      return captureViewportFocalAnchor({
        viewport: viewportRect,
        pages,
        preferredPageIndex: pageIndex,
        clientX,
        clientY,
      });
    },
    [pageIndex],
  );

  const preserveFocalPoint = useCallback(
    (change: () => void, clientX?: number, clientY?: number) => {
      pendingFocalAnchorRef.current = captureFocalAnchor(clientX, clientY);
      setFocalRestoreRevision((revision) => revision + 1);
      change();
    },
    [captureFocalAnchor],
  );

  const closeTransientChrome = useCallback(() => {
    setMobileMenuOpen(false);
    setMobileThumbnailOpen(false);
    setSearchOpen(false);
    setAnnotationOpen(false);
    setComicSettingsOpen(false);
    setListeningPreparationOpen(false);
    setSelectionMode(false);
    setRegionMode(false);
    setPendingTextSelection(undefined);
    setPendingRegionSelection(undefined);
    setReanchorTargetId(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const toggleImmersive = useCallback(() => {
    if (!immersive) closeTransientChrome();
    setImmersive((current) => !current);
  }, [closeTransientChrome, immersive]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) return;
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    syncFullscreen();
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useLayoutEffect(
    () => scheduleViewportFocalRestore(pendingFocalAnchorRef, viewportRef),
    [
      effectiveViewMode,
      fit,
      focalRestoreRevision,
      rotation,
      sidebarOpen,
      viewportSize.height,
      viewportSize.width,
      zoom,
    ],
  );
  const comicSpreads = useMemo(
    () => (effectiveViewMode === 'spread' ? buildComicSpreads(totalPages, comicProfile, comicPageHints) : []),
    [comicPageHints, comicProfile, effectiveViewMode, totalPages],
  );
  const currentDocumentSectionIndex = useMemo(
    () => continuousComicSectionIndex(documentSections, pageIndex),
    [documentSections, pageIndex],
  );
  const currentDocumentSection = documentSections[currentDocumentSectionIndex];
  const previousDocumentSection = documentSections[currentDocumentSectionIndex - 1];
  const nextDocumentSection = documentSections[currentDocumentSectionIndex + 1];
  const hasPreviousSection = Boolean(previousDocumentSection || remoteNavigation?.previous);
  const hasNextSection = Boolean(nextDocumentSection || remoteNavigation?.next);
  const navigateSection = (direction: -1 | 1) => {
    if (remoteNavigation?.busy) return;
    const section = direction === -1 ? previousDocumentSection : nextDocumentSection;
    if (section) {
      goToPage(section.startPageIndex);
      return;
    }
    const action = direction === -1 ? remoteNavigation?.previous : remoteNavigation?.next;
    setNavigationError('');
    return action?.().catch((error: unknown) =>
      setNavigationError(error instanceof Error ? error.message : '회차를 열지 못했습니다.'),
    );
  };
  const continuousPageIndexes = useMemo(
    () =>
      continuousComicPageIndexes(
        totalPages,
        currentDocumentSection ? [currentDocumentSection] : [],
        currentDocumentSection?.startPageIndex ?? 0,
      ),
    [currentDocumentSection, totalPages],
  );
  const continuousVirtualIndexByPage = useMemo(
    () => new Map(continuousPageIndexes.map((globalPageIndex, virtualIndex) => [globalPageIndex, virtualIndex])),
    [continuousPageIndexes],
  );
  const continuousSectionKey = currentDocumentSection?.id ?? `${novel.id}:all-pages`;
  const stableComicFlow = seamlessContinuousView && novel.format === 'image_archive';
  const comicFlow = useComicPageFlow(stableComicFlow, continuousPageIndexes, viewportRef, continuousContentRef);
  const scrollComicFlowToPage = comicFlow.scrollToPage;
  const { estimateContinuousPageSize, seamlessContinuousPageWidth } = useComicPageSizes(
    imageDimensions,
    sortedChapters,
    viewportSize,
    fit,
    zoom,
    seamlessContinuousView,
    stableComicFlow,
  );
  const continuousPageKey = useCallback(
    (index: number) => sortedChapters[continuousPageIndexes[index]]?.id ?? `${novel.id}:${index}`,
    [continuousPageIndexes, novel.id, sortedChapters],
  );
  const continuousVirtualizer = useVirtualizer({
    count: continuousView && !stableComicFlow ? continuousPageIndexes.length : 0,
    getItemKey: continuousPageKey,
    getScrollElement: () => viewportRef.current,
    estimateSize: (virtualIndex) => estimateContinuousPageSize(continuousPageIndexes[virtualIndex] ?? pageIndex),
    gap: seamlessContinuousView ? -1 : 32,
    overscan: 2,
  });
  continuousVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAnchorContinuousPageResize(item.end, instance.scrollOffset ?? 0, Boolean(pendingFocalAnchorRef.current));
  const sidebarVirtualizer = useVirtualizer({
    count: sidebarOpen ? totalPages : 0,
    getScrollElement: () => sidebarRef.current,
    estimateSize: () => 180,
    overscan: 4,
  });
  const continuousItems = continuousVirtualizer.getVirtualItems();
  const sidebarItems = sidebarVirtualizer.getVirtualItems();
  const continuousDisplayedPages = continuousItems
    .map((item) => continuousPageIndexes[item.index])
    .filter((index) => index !== undefined);
  const displayedPages = stableComicFlow
    ? continuousPageIndexes
    : continuousView
      ? continuousDisplayedPages.length
        ? continuousDisplayedPages
        : [pageIndex]
      : effectiveViewMode === 'spread' && novel.format === 'image_archive'
        ? comicSpreadPages(comicSpreads[comicSpreadForPage(comicSpreads, pageIndex)] ?? { readingOrder: [pageIndex] })
        : [pageIndex];
  const displayedPageKey = [...(stableComicFlow ? comicFlow.nearby : displayedPages)]
    .sort((left, right) => left - right)
    .join(',');
  const wantedPageKey = [...new Set([...displayedPages, ...sidebarItems.map((item) => item.index)])]
    .sort((left, right) => left - right)
    .join(',');
  const wantedPageIndexes = useMemo(
    () => new Set(wantedPageKey.split(',').filter(Boolean).map(Number)),
    [wantedPageKey],
  );
  const nextAutoPages = useMemo(() => {
    const end = currentDocumentSection
      ? currentDocumentSection.startPageIndex + currentDocumentSection.pageCount
      : totalPages;
    const pages =
      effectiveViewMode === 'spread'
        ? (comicSpreads[comicSpreadForPage(comicSpreads, pageIndex) + 1]?.readingOrder ?? [])
        : [pageIndex + 1];
    return pages.length && pages[0] < end ? pages.filter((index) => index < totalPages) : [];
  }, [currentDocumentSection, totalPages, effectiveViewMode, comicSpreads, pageIndex]);
  const streamVisiblePageKey = (stableComicFlow ? comicFlow.visible : displayedPages).join(',');
  const streamPrefetch = remoteNavigation?.prefetchPages;
  const imageWantedPageIndexes = useMemo(() => {
    const displayed = displayedPageKey.split(',').filter(Boolean).map(Number);
    const wanted =
      streamPrefetch !== undefined
        ? streamImageWindow(
            streamVisiblePageKey.split(',').filter(Boolean).map(Number),
            pageIndex,
            totalPages,
            streamPrefetch,
          )
        : archiveFullImageWindow(displayed, pageIndex, totalPages);
    if (!continuousView) return new Set(streamPrefetch === 0 ? wanted : [...wanted, ...nextAutoPages]);
    if (!currentDocumentSection) return new Set(wanted);
    const sectionEnd = currentDocumentSection.startPageIndex + currentDocumentSection.pageCount;
    return new Set(wanted.filter((index) => index >= currentDocumentSection.startPageIndex && index < sectionEnd));
  }, [
    continuousView,
    currentDocumentSection,
    displayedPageKey,
    pageIndex,
    totalPages,
    nextAutoPages,
    streamPrefetch,
    streamVisiblePageKey,
  ]);

  const recordArchiveImageDimensions = useCallback(
    (index: number, dimensions: ContinuousImageDimensions) => {
      const key = sortedChapters[index]?.id;
      if (!key || dimensions.width <= 0 || dimensions.height <= 0) return;
      const known = imageDimensions.get(key);
      if (known?.width === dimensions.width && known?.height === dimensions.height) return;
      setImageDimensions((previous) => new Map(previous).set(key, dimensions));
    },
    [sortedChapters, imageDimensions],
  );
  const comicProfileEditVersion = useRef(0);
  const comicLayout = useSourceComicLayout({
    document: { novel, chapters, repository, assets },
    profiles: comicReadingProfileRepository,
    profileKey: remoteNavigation?.profileKey ?? novel.id,
    detect: Boolean(remoteNavigation?.profileKey || chapters.some((chapter) => chapter.documentSectionId)),
    editVersion: comicProfileEditVersion,
    begin: () => {
      setComicProfile((current) =>
        remoteNavigation?.profileKey ? { ...current, pageCrops: undefined } : DEFAULT_COMIC_READING_PROFILE,
      );
      setComicPageHints(new Map());
    },
    apply: (profile) => {
      setComicProfile(profile);
      setViewMode(comicProfileModeToViewMode(profile.mode, profile.seamlessVertical));
      setFit(profile.fit);
    },
  });
  const layoutReady = comicLayout.layoutReady;
  const layoutCallbacks = useRef({ onLayoutReadyChange, onLayoutStateChange });
  layoutCallbacks.current = { onLayoutReadyChange, onLayoutStateChange };
  useEffect(() => {
    layoutCallbacks.current.onLayoutReadyChange?.(layoutReady);
    layoutCallbacks.current.onLayoutStateChange?.({ layoutReady, error: comicLayout.error, retry: comicLayout.retry });
  }, [layoutReady, comicLayout.error, comicLayout.retry]);
  const archiveImages = useArchivePageImages({
    enabled: novel.format === 'image_archive' && layoutReady,
    bookId: novel.id,
    sourceRevision: novel.activeContentRevisionId ?? novel.sourceContentHash ?? novel.rawTextHash,
    chapters: sortedChapters,
    currentPage: pageIndex,
    wantedPages: imageWantedPageIndexes,
    repository,
    assets,
    retainedPages: stableComicFlow && !remoteNavigation ? continuousPageIndexes : undefined,
    onDimensions: recordArchiveImageDimensions,
    onPageInvalid: remoteNavigation?.invalidatePage,
  });
  const { pdf, pdfPages, status, errorMessage } = usePdfDocumentSession({
    enabled: novel.format === 'pdf',
    bookId: novel.id,
    sourceRevision: novel.activeContentRevisionId ?? novel.sourceContentHash ?? novel.rawTextHash,
    assets,
    currentPage: pageIndex,
    totalPages,
    wantedPages: wantedPageIndexes,
  });
  const textSession = usePdfTextSession({
    novel,
    pdf,
    pages: pdfPages,
    displayedPageKey,
    repository: documentTextRepository,
    annotations: documentAnnotationRepository,
    onAnnotations: setDocumentAnnotations,
  });
  const { textBlocksByPage, textPageStates, readyTextPages, textIndexProgress, indexAllPdfText, cancelIndex } =
    textSession;
  const { searchQuery, setSearchQuery, searchResults, searchCursor, searchStatus, jumpToSearchResult } =
    usePdfTextSearch({
      bookId: novel.id,
      scope: pdfTextScope(novel),
      open: searchOpen,
      version: textSession.textVersion,
      readyPages: readyTextPages,
      repository: documentTextRepository,
      goToPage,
    });
  const {
    readingOrderOpen,
    setReadingOrderOpen,
    readingOrderRevision,
    readingOrderBlocks,
    readingOrderExcludedIds,
    readingOrderStatus,
    readingOrderError,
    openReadingOrderEditor,
    moveReadingOrderBlock,
    toggleReadingOrderExcluded,
    saveReadingOrder,
    resetReadingOrder,
  } = usePdfReadingOrder({
    novel,
    pdf,
    pages: pdfPages,
    pageIndex,
    searchOpen,
    repository: documentTextRepository,
    text: textSession,
  });
  const {
    ocrLanguage,
    setOcrLanguage,
    ocrRangeStart,
    setOcrRangeStart,
    ocrRangeEnd,
    setOcrRangeEnd,
    ocrWorkerLanguage,
    ocrProgress,
    ocrError,
    ocrModelCache,
    ocrModelCacheStatus,
    ocrModelCacheError,
    runOcrPages,
    runOcrRange,
    cancelOcr,
    unloadOcrWorker,
    removeOcrModel,
    refreshOcrModelCache,
  } = usePdfOcrController({
    novel,
    pdf,
    pages: pdfPages,
    pageIndex,
    totalPages,
    searchOpen,
    repository: documentTextRepository,
    text: textSession,
  });
  const archiveError = archiveImages.errors.get(pageIndex);
  const documentStatus =
    novel.format === 'image_archive'
      ? archiveError
        ? 'failed'
        : archiveImages.pages.has(pageIndex)
          ? 'ready'
          : 'loading'
      : status;

  const flushReadingProgress = useFixedDocumentReadingPosition({
    restorePage: goToPage,
    novel,
    chapters: sortedChapters,
    owner: repository,
    readingPosition,
    initialChapterId,
    save: onPageSettled,
    identity: `${novel.id}:${entryRequestVersion ?? 0}`,
    continuous: continuousView,
    page: pageIndex,
    ready: documentStatus === 'ready' && layoutReady,
    viewport: viewportRef,
    content: continuousContentRef,
    initial: remoteNavigation?.initialPosition,
    savePosition: remoteNavigation?.savePosition,
  });

  const turnPage = useCallback(
    (step: -1 | 1) => {
      if (!continuousView && comicProfile.pageTurnMotion !== 'instant') {
        window.clearTimeout(pageTurnTimerRef.current);
        const visualStep: -1 | 1 =
          novel.format === 'image_archive' && comicProfile.direction === 'rtl' ? (step === 1 ? -1 : 1) : step;
        setPageTurnDirection(visualStep);
        pageTurnTimerRef.current = window.setTimeout(() => setPageTurnDirection(undefined), 240);
      }
      if (effectiveViewMode === 'spread' && novel.format === 'image_archive') {
        const currentSpread = comicSpreadForPage(comicSpreads, pageIndex);
        const target = comicSpreads[Math.max(0, Math.min(comicSpreads.length - 1, currentSpread + step))];
        if (target) goToPage(target.readingOrder[0]);
        return;
      }
      goToPage(pageIndex + step);
    },
    [
      comicProfile.direction,
      comicProfile.pageTurnMotion,
      comicSpreads,
      continuousView,
      effectiveViewMode,
      goToPage,
      novel.format,
      pageIndex,
    ],
  );

  useEffect(() => () => window.clearTimeout(pageTurnTimerRef.current), []);

  const updateComicProfile = useCallback(
    (change: Partial<ComicReadingProfile>) => {
      comicProfileEditVersion.current++;
      setComicProfile((current) => {
        const next = { ...current, ...change };
        void comicReadingProfileRepository.save(remoteNavigation?.profileKey ?? novel.id, next, comicCropKey(novel));
        return next;
      });
    },
    [novel, remoteNavigation?.profileKey, comicReadingProfileRepository],
  );

  const changeComicViewMode = (next: ViewMode) => {
    preserveFocalPoint(() => {
      setViewMode(next);
      if (next === 'continuous-seamless') setZoom(1);
    });
    updateComicProfile({ mode: comicViewModeToProfileMode(next), seamlessVertical: next === 'continuous-seamless' });
  };
  const changeComicFit = (next: FitMode) => {
    preserveFocalPoint(() => {
      setFit(next);
      setZoom(1);
    });
    updateComicProfile({ fit: next });
  };

  const recordComicPageHint = useCallback((index: number, hint: ComicPageLayoutHint) => {
    setComicPageHints((previous) => {
      const current = previous.get(index);
      if (current?.type === hint.type && current?.doublePage === hint.doublePage) return previous;
      return new Map(previous).set(index, hint);
    });
  }, []);

  const loadComicPageBlob = useCallback(
    async (index: number) => {
      const chapter = sortedChapters[index];
      const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0) : undefined;
      const assetId = paragraphPage?.paragraphs[0]?.assetId;
      const resource = assetId ? await assets.getEmbeddedResource(novel.id, assetId) : undefined;
      if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
      return resource.blob;
    },
    [assets, novel.id, repository, sortedChapters],
  );

  const autoCropPages = useCallback(
    async (indexes: readonly number[]) => {
      if (indexes.length === 0 || comicCropControllerRef.current || comicCropStatus === 'running') return;
      const controller = new AbortController();
      comicCropControllerRef.current = controller;
      setComicCropStatus('running');
      setComicCropFailedPages(0);
      setComicCropProgress({ current: 0, total: indexes.length, detected: 0 });
      try {
        const result = await runComicAutoCropBatch({
          pageIndexes: indexes,
          existing: comicProfile.pageCrops,
          signal: controller.signal,
          analyze: async (index, signal) => {
            const blob = await loadComicPageBlob(index);
            if (signal.aborted) throw new DOMException('Comic crop cancelled.', 'AbortError');
            return detectComicCrop(blob);
          },
          onProgress: (current, total, detected) => setComicCropProgress({ current, total, detected }),
        });
        if (result.detected > 0) updateComicProfile({ crop: 'auto', pageCrops: result.pageCrops });
        setComicCropFailedPages(result.failedPages.length);
        setComicCropStatus(result.failedPages.length > 0 ? 'failed' : 'idle');
      } catch {
        setComicCropStatus('failed');
      } finally {
        if (comicCropControllerRef.current === controller) {
          comicCropControllerRef.current = undefined;
          setComicCropProgress(undefined);
        }
      }
    },
    [comicCropStatus, comicProfile.pageCrops, loadComicPageBlob, updateComicProfile],
  );

  const prepareAllDocumentThumbnails = useCallback(async () => {
    const pdfDocument = pdf;
    const isPdf = novel.format === 'pdf';
    if (
      !persistThumbnails ||
      (isPdf && !pdfDocument) ||
      (!isPdf && novel.format !== 'image_archive') ||
      thumbnailBatchControllerRef.current
    ) {
      return;
    }
    const pageCount = isPdf ? (pdfDocument?.numPages ?? 0) : totalPages;
    const controller = new AbortController();
    const renderFingerprint = isPdf ? pdfThumbnailFingerprint() : archiveThumbnailFingerprint();
    const archiveIdentities = new Map<number, Promise<{ assetId: string; pageHash: string }>>();
    const resolveArchiveIdentity = (index: number) => {
      const existing = archiveIdentities.get(index);
      if (existing) return existing;
      const task = (async () => {
        const chapter = sortedChapters[index];
        const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0) : undefined;
        const assetId = paragraphPage?.paragraphs[0]?.assetId;
        if (!assetId) throw new Error(`${index + 1}페이지 이미지 정보를 찾을 수 없습니다.`);
        return {
          assetId,
          pageHash: archiveThumbnailPageHash(assetId, index),
        };
      })();
      archiveIdentities.set(index, task);
      return task;
    };
    thumbnailBatchControllerRef.current = controller;
    setThumbnailBatchSummary(undefined);
    setThumbnailBatchProgress({ current: 0, total: pageCount, rendered: 0, failed: 0 });
    try {
      const result = await runDocumentThumbnailBatch({
        totalPages: pageCount,
        signal: controller.signal,
        isCached: async (index) => {
          const pageHash = isPdf ? pdfPageHash(novel, index) : (await resolveArchiveIdentity(index)).pageHash;
          return Boolean(
            await getDocumentThumbnail({
              bookId: novel.id,
              pageIndex: index,
              pageHash,
              renderFingerprint,
              touch: false,
            }),
          );
        },
        renderPage: async (index, signal) => {
          if (isPdf && pdfDocument) {
            const cached = pdfPages.get(index);
            const page = cached ?? (await pdfDocument.getPage(index + 1));
            try {
              const rendered = await renderPdfThumbnail(page, signal);
              await saveDocumentThumbnail({
                bookId: novel.id,
                pageIndex: index,
                pageHash: pdfPageHash(novel, index),
                renderFingerprint: rendered.renderFingerprint,
                contentType: rendered.contentType,
                pixelWidth: rendered.pixelWidth,
                pixelHeight: rendered.pixelHeight,
                blob: rendered.blob,
              });
            } finally {
              if (!cached) page.cleanup();
            }
            return;
          }
          const identity = await resolveArchiveIdentity(index);
          const resource = await assets.getEmbeddedResource(novel.id, identity.assetId);
          if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
          const rendered = await renderArchiveThumbnail(resource.blob, signal);
          await saveDocumentThumbnail({
            bookId: novel.id,
            pageIndex: index,
            pageHash: identity.pageHash,
            renderFingerprint: rendered.renderFingerprint,
            contentType: rendered.contentType,
            pixelWidth: rendered.pixelWidth,
            pixelHeight: rendered.pixelHeight,
            blob: rendered.blob,
          });
        },
        onProgress: setThumbnailBatchProgress,
      });
      await pruneDocumentThumbnails(novel.id);
      setThumbnailBatchSummary({
        rendered: result.rendered,
        failed: result.failed,
        cancelled: result.cancelled,
      });
    } finally {
      if (thumbnailBatchControllerRef.current === controller) thumbnailBatchControllerRef.current = undefined;
      setThumbnailBatchProgress(undefined);
    }
  }, [assets, novel, pdf, pdfPages, repository, sortedChapters, totalPages, persistThumbnails]);

  const reloadDocumentAnnotations = useCallback(async () => {
    setDocumentAnnotations(await documentAnnotationRepository.list(novel.id));
  }, [documentAnnotationRepository, novel.id]);

  const togglePageBookmark = useCallback(async () => {
    const existing = documentAnnotations.find(
      (annotation) => annotation.pageIndex === pageIndex && annotation.type === 'page_bookmark',
    );
    if (existing) await documentAnnotationRepository.remove(existing.id);
    else {
      const timestamp = new Date().toISOString();
      await documentAnnotationRepository.save({
        id: persistentId128('document_annotation', [novel.id, 'page_bookmark', String(pageIndex)]),
        bookId: novel.id,
        pageIndex,
        type: 'page_bookmark',
        anchor: { kind: 'fixed_page', bookId: novel.id, pageIndex, pageHash: pdfPageHash(novel, pageIndex) },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    await reloadDocumentAnnotations();
  }, [documentAnnotationRepository, documentAnnotations, novel, pageIndex, reloadDocumentAnnotations]);

  const saveTextAnnotation = useCallback(
    async (type: 'text_highlight' | 'text_note') => {
      const selection = pendingTextSelection;
      if (!selection) return;
      const first = selection.ranges[0];
      const last = selection.ranges.at(-1);
      if (!first || !last) return;
      const timestamp = new Date().toISOString();
      const id = persistentId128('document_annotation', [
        novel.id,
        type,
        selection.textRevisionId,
        ...selection.ranges.flatMap((range) => [range.block.id, String(range.startOffset), String(range.endOffset)]),
      ]);
      const existing = documentAnnotations.find((annotation) => annotation.id === id);
      await documentAnnotationRepository.save({
        id,
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        type,
        anchor: {
          kind: 'fixed_text',
          bookId: novel.id,
          pageIndex: selection.pageIndex,
          textRevisionId: selection.textRevisionId,
          blockId: first.block.id,
          startOffset: first.startOffset,
          endOffset: last.endOffset,
          blockRanges: selection.ranges.map((range) => ({
            blockId: range.block.id,
            startOffset: range.startOffset,
            endOffset: range.endOffset,
          })),
          quads: [...selection.quads],
        },
        quote: selection.quote,
        body: type === 'text_note' ? selectionNoteDraft.trim() : undefined,
        color: type === 'text_highlight' ? 'yellow' : 'blue',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      window.getSelection()?.removeAllRanges();
      setPendingTextSelection(undefined);
      setSelectionNoteDraft('');
      await reloadDocumentAnnotations();
    },
    [
      documentAnnotationRepository,
      documentAnnotations,
      novel.id,
      pendingTextSelection,
      reloadDocumentAnnotations,
      selectionNoteDraft,
    ],
  );

  const manuallyReanchorAnnotation = useCallback(async () => {
    const selection = pendingTextSelection;
    const annotation = documentAnnotations.find((item) => item.id === reanchorTargetId);
    const first = selection?.ranges[0];
    const last = selection?.ranges.at(-1);
    if (!selection || !annotation || !first || !last) return;
    const updatedAt = new Date().toISOString();
    const updated = manuallyReanchorFixedTextAnnotation({
      annotation,
      quote: selection.quote,
      updatedAt,
      anchor: {
        kind: 'fixed_text',
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        textRevisionId: selection.textRevisionId,
        blockId: first.block.id,
        startOffset: first.startOffset,
        endOffset: last.endOffset,
        blockRanges: selection.ranges.map((range) => ({
          blockId: range.block.id,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
        })),
        quads: [...selection.quads],
      },
    });
    await documentAnnotationRepository.save(updated);
    window.getSelection()?.removeAllRanges();
    setPendingTextSelection(undefined);
    setReanchorTargetId(undefined);
    setSelectionMode(false);
    await reloadDocumentAnnotations();
  }, [
    documentAnnotationRepository,
    documentAnnotations,
    novel.id,
    pendingTextSelection,
    reanchorTargetId,
    reloadDocumentAnnotations,
  ]);

  const saveRegionAnnotation = useCallback(
    async (type: 'region_highlight' | 'region_note') => {
      const selection = pendingRegionSelection;
      if (!selection) return;
      const timestamp = new Date().toISOString();
      const coordinates = [selection.quad.x, selection.quad.y, selection.quad.width, selection.quad.height].map(
        (value) => value.toFixed(6),
      );
      const id = persistentId128('document_annotation', [novel.id, type, String(selection.pageIndex), ...coordinates]);
      const existing = documentAnnotations.find((annotation) => annotation.id === id);
      await documentAnnotationRepository.save({
        id,
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        type,
        anchor: {
          kind: 'fixed_region',
          bookId: novel.id,
          pageIndex: selection.pageIndex,
          pageHash: pdfPageHash(novel, selection.pageIndex),
          quads: [selection.quad],
        },
        body: type === 'region_note' ? regionNoteDraft.trim() : undefined,
        color: type === 'region_highlight' ? 'yellow' : 'blue',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      setPendingRegionSelection(undefined);
      setRegionNoteDraft('');
      await reloadDocumentAnnotations();
    },
    [
      documentAnnotationRepository,
      documentAnnotations,
      novel,
      pendingRegionSelection,
      regionNoteDraft,
      reloadDocumentAnnotations,
    ],
  );

  const removeDocumentAnnotation = useCallback(
    async (id: string) => {
      await documentAnnotationRepository.remove(id);
      if (reanchorTargetId === id) {
        setReanchorTargetId(undefined);
        setSelectionMode(false);
      }
      await reloadDocumentAnnotations();
    },
    [documentAnnotationRepository, reanchorTargetId, reloadDocumentAnnotations],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      const current = viewportSizeRef.current;
      const measured = viewportMeasuredRef.current;
      viewportMeasuredRef.current = true;
      if (current.width === next.width && current.height === next.height) return;
      if (measured) {
        renewViewportFocalRestore(pendingFocalAnchorRef, captureFocalAnchor);
        // A newer measurement must supersede a pending RAF even before React commits it.
        // Revision also covers a coalesced resize A → B → A with unchanged final dimensions.
        setFocalRestoreRevision((revision) => revision + 1);
      }
      viewportSizeRef.current = next;
      setViewportSize(next);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [captureFocalAnchor]);

  useLayoutEffect(() => {
    continuousVirtualizer.measure();
  }, [continuousVirtualizer, effectiveViewMode, fit, rotation, viewportSize.height, viewportSize.width, zoom]);

  useLayoutEffect(() => {
    if (!continuousView) return;
    const pendingPage = pendingContinuousPageRef.current;
    const targetPage = pendingPage ?? pageIndex;
    const virtualIndex = continuousVirtualIndexByPage.get(targetPage) ?? 0;
    pendingContinuousPageRef.current = undefined;
    if (stableComicFlow) {
      comicFlow.scrollToPage(targetPage);
      return;
    }
    if (pendingPage !== undefined) {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTo({ top: 0, left: viewport.scrollLeft });
      continuousVirtualizer.scrollToIndex(virtualIndex, { align: 'start' });
    }
    const frame = window.requestAnimationFrame(() =>
      continuousVirtualizer.scrollToIndex(virtualIndex, {
        align: pendingPage === undefined && !seamlessContinuousView ? 'center' : 'start',
      }),
    );
    return () => window.cancelAnimationFrame(frame);
    // Settle when the layout or active episode changes. Scroll tracking owns later page changes inside the episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuousSectionKey, continuousView, effectiveViewMode, seamlessContinuousView, stableComicFlow]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const frame = window.requestAnimationFrame(() => sidebarVirtualizer.scrollToIndex(pageIndex, { align: 'center' }));
    return () => window.cancelAnimationFrame(frame);
    // Do not pull the thumbnail rail back while the user is browsing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen]);

  useEffect(() => {
    if (!mobileThumbnailOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sidebarVirtualizer.measure();
      sidebarVirtualizer.scrollToIndex(pageIndex, { align: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobileThumbnailOpen, pageIndex, sidebarVirtualizer]);

  useEffect(() => {
    if (novel.format !== 'pdf' || novel.coverAssetId || !pdf || !assets.saveGeneratedCover) return;
    const sourceHash = novel.sourceContentHash ?? novel.rawTextHash;
    const pageHash = pdfPageHash(novel, 0);
    const attemptKey = `${sourceHash}:${pageHash}`;
    if (generatedCoverAttemptRef.current === attemptKey) return;
    generatedCoverAttemptRef.current = attemptKey;
    let active = true;
    void (async () => {
      const cached = pdfPages.get(0);
      const page = cached ?? (await pdf.getPage(1));
      try {
        const input = await renderPdfGeneratedCover({ page, sourceHash, pageHash });
        const cover = await assets.saveGeneratedCover?.(novel.id, input);
        if (active && cover) onGeneratedCover?.(cover);
      } finally {
        if (!cached) page.cleanup();
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [assets, novel, onGeneratedCover, pdf, pdfPages]);

  useEffect(() => {
    setPendingTextSelection(undefined);
    setSelectionNoteDraft('');
    void reloadDocumentAnnotations();
  }, [annotationSyncRevision, reloadDocumentAnnotations]);

  useEffect(() => () => thumbnailBatchControllerRef.current?.abort(), []);

  useEffect(() => {
    setComicPageHints((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const [index, page] of archiveImages.pages) {
        if (!page.hint) continue;
        const current = next.get(index);
        if (current?.type === page.hint.type && current?.doublePage === page.hint.doublePage) continue;
        next.set(index, page.hint);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [archiveImages.pages]);

  useEffect(
    () => () => {
      comicCropControllerRef.current?.abort();
      if (viewportScrollFrameRef.current !== undefined) cancelAnimationFrame(viewportScrollFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleFixedDocumentKeyDown(event, {
        rtl: novel.format === 'image_archive' && comicProfile.direction === 'rtl',
        turnPage,
        toggleImmersive,
        toggleFullscreen: () => void toggleFullscreen(),
        zoomBy: (delta) => preserveFocalPoint(() => setZoom((value) => Math.max(0.5, Math.min(3, value + delta)))),
        dismiss: () => {
          if (pendingRegionSelection) setPendingRegionSelection(undefined);
          else if (pendingTextSelection) setPendingTextSelection(undefined);
          else if (reanchorTargetId) {
            setReanchorTargetId(undefined);
            setSelectionMode(false);
          } else if (mobileThumbnailOpen) setMobileThumbnailOpen(false);
          else if (mobileMenuOpen) setMobileMenuOpen(false);
          else if (regionMode) setRegionMode(false);
          else if (readingOrderOpen) setReadingOrderOpen(false);
          else if (searchOpen) setSearchOpen(false);
          else if (annotationOpen) setAnnotationOpen(false);
          else if (comicSettingsOpen) setComicSettingsOpen(false);
          else if (listeningPreparationOpen) setListeningPreparationOpen(false);
          else if (immersive) setImmersive(false);
          else if (document.fullscreenElement) void toggleFullscreen();
          else return false;
          return true;
        },
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    annotationOpen,
    comicProfile.direction,
    comicSettingsOpen,
    listeningPreparationOpen,
    mobileMenuOpen,
    mobileThumbnailOpen,
    novel.format,
    pendingRegionSelection,
    pendingTextSelection,
    reanchorTargetId,
    readingOrderOpen,
    setReadingOrderOpen,
    regionMode,
    searchOpen,
    preserveFocalPoint,
    immersive,
    toggleFullscreen,
    toggleImmersive,
    turnPage,
  ]);

  const seekWindow = fixedDocumentSeekWindow(
    totalPages,
    pageIndex,
    novel.format === 'image_archive' ? currentDocumentSection : undefined,
  );
  const ocrCandidatePages = [...textPageStates]
    .filter(([, state]) => state === 'ocr_candidate' || state === 'failed')
    .map(([index]) => index)
    .sort((left, right) => left - right);
  const currentPageBookmarked = documentAnnotations.some(
    (annotation) => annotation.pageIndex === pageIndex && annotation.type === 'page_bookmark',
  );
  const pageStyle = {
    '--fixed-doc-zoom': zoom,
    '--fixed-doc-rotation': `${rotation}deg`,
    '--fixed-doc-brightness': comicProfile.brightness,
    '--fixed-doc-contrast': comicProfile.contrast,
    '--fixed-doc-saturation': comicProfile.saturation,
    '--fixed-doc-grayscale': comicProfile.grayscale ? 1 : 0,
    '--fixed-doc-invert': comicProfile.invert ? 1 : 0,
    '--fixed-doc-gap': `${novel.format === 'image_archive' ? (comicProfile.gap ?? 8) : 32}px`,
    '--fixed-doc-image-clip':
      comicProfile.crop === 'off' ||
      (comicProfile.crop === 'manual' && !Object.values(comicProfile.manualCrop ?? {}).some((value) => value > 0))
        ? 'none'
        : undefined,
    '--fixed-doc-crop-top': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.top ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-right': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.right ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-bottom': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.bottom ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-left': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.left ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-scale': comicProfile.crop === 'manual' ? comicCropRefitScale(comicProfile.manualCrop, fit) : 1,
    '--fixed-doc-original-scale': fit === 'original' ? zoom : 1,
    '--fixed-doc-viewport-width': `${viewportSize.width}px`,
    '--fixed-doc-viewport-height': `${viewportSize.height}px`,
  } as CSSProperties;
  const continuousSectionFooterHeight =
    continuousView && currentDocumentSection
      ? hasNextSection
        ? CONTINUOUS_SECTION_BOUNDARY_HEIGHT
        : CONTINUOUS_SECTION_NAV_HEIGHT
      : 0;
  const autoScopeSuffix = `${effectiveViewMode}:${fit}:${zoom}:${rotation}`;
  const autoReadingAllowed =
    novel.format === 'image_archive' &&
    !comicSettingsOpen &&
    !mobileMenuOpen &&
    !mobileThumbnailOpen &&
    !searchOpen &&
    !annotationOpen;
  const autoReading = useComicAutoReading({
    viewport: viewportRef,
    content: continuousContentRef,
    continuous: continuousView,
    scope: remoteNavigation
      ? `${remoteNavigation.scope}:${autoScopeSuffix}`
      : `${novel.id}:${continuousSectionKey}:${autoScopeSuffix}`,
    allowed: autoReadingAllowed && documentStatus !== 'failed',
    ready: documentStatus === 'ready' && !remoteNavigation?.busy,
    visiblePages: displayedPages,
    nearbyPages: stableComicFlow ? comicFlow.nearby : displayedPages,
    nextPages: nextAutoPages,
    pages: archiveImages.pages,
    errors: archiveImages.errors,
    footerHeight: continuousSectionFooterHeight,
    turn: () => turnPage(1),
    reportError: archiveImages.reportError,
    nextChapter: nextDocumentSection
      ? {
          scope: `${novel.id}:${nextDocumentSection.id}:${autoScopeSuffix}`,
          open: async (isCurrent) => {
            if (isCurrent()) goToPage(nextDocumentSection.startPageIndex);
          },
        }
      : remoteNavigation?.next
        ? { scope: `${remoteNavigation.nextScope}:${autoScopeSuffix}`, open: remoteNavigation.next }
        : undefined,
  });
  useEffect(() => {
    if (continuousView) {
      closeTransientChrome();
      setImmersive(true);
    }
  }, [continuousView, closeTransientChrome]);
  useEffect(() => {
    if (autoReading.running) {
      closeTransientChrome();
      setImmersive(true);
    }
  }, [autoReading.running, closeTransientChrome]);
  const scrollSectionBoundary = useScrollChapterBoundary({
    rootRef: viewportRef,
    contentRef: continuousContentRef,
    chapterId: continuousSectionKey,
    enabled:
      continuousView &&
      !autoReading.running &&
      !remoteNavigation?.busy &&
      documentStatus === 'ready' &&
      Boolean(currentDocumentSection && hasNextSection),
    onNextChapter: () => navigateSection(1),
  });

  const pointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (isFixedDocumentInteractiveTarget(event.target)) return;
    if (activePointersRef.current.size === 0) pointerPanAxisRef.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      immersiveEligible: true,
    };
    if (activePointersRef.current.size === 1 && continuousView)
      scrollSectionBoundary.onPointerDown(event.clientY, event.pointerType);
    if (activePointersRef.current.size === 2) {
      pointerPanAxisRef.current = undefined;
      const [first, second] = [...activePointersRef.current.values()];
      const midpointX = (first.x + second.x) / 2;
      const midpointY = (first.y + second.y) / 2;
      pinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom,
        active: true,
        anchor: captureFocalAnchor(midpointX, midpointY),
      };
      pointerStartRef.current = undefined;
    }
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const previous = activePointersRef.current.get(event.pointerId);
    if (!previous) return;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointersRef.current.size >= 2) {
      event.preventDefault();
      const [first, second] = [...activePointersRef.current.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const pinch = pinchRef.current;
      if (pinch && pinch.distance > 0) {
        const midpointX = (first.x + second.x) / 2;
        const midpointY = (first.y + second.y) / 2;
        const viewportRect = viewportRef.current?.getBoundingClientRect();
        if (pinch.anchor && viewportRect) {
          pendingFocalAnchorRef.current = {
            ...pinch.anchor,
            viewportOffsetX: midpointX - viewportRect.left,
            viewportOffsetY: midpointY - viewportRect.top,
          };
          setFocalRestoreRevision((revision) => revision + 1);
          setZoom(Math.max(0.5, Math.min(3, pinch.zoom * (distance / pinch.distance))));
        } else {
          preserveFocalPoint(
            () => setZoom(Math.max(0.5, Math.min(3, pinch.zoom * (distance / pinch.distance)))),
            midpointX,
            midpointY,
          );
        }
      }
      return;
    }
    if (continuousView && scrollSectionBoundary.onPointerMove(event.clientY, event.pointerType)) {
      event.preventDefault();
      return;
    }
    const viewport = viewportRef.current;
    const start = pointerStartRef.current;
    if (viewport && !pointerPanAxisRef.current) {
      pointerPanAxisRef.current = fixedDocumentPanAxis({
        zoom,
        continuousView,
        deltaX: event.clientX - (start?.x ?? previous.x),
        deltaY: event.clientY - (start?.y ?? previous.y),
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
      });
    }
    const panAxis = pointerPanAxisRef.current;
    if (viewport && panAxis) {
      event.preventDefault();
      viewport.scrollBy({
        left: panAxis === 'y' ? 0 : previous.x - event.clientX,
        top: panAxis === 'x' ? 0 : previous.y - event.clientY,
      });
      pointerStartRef.current = undefined;
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const wasPinching = Boolean(pinchRef.current?.active);
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size === 0) pointerPanAxisRef.current = undefined;
    if (activePointersRef.current.size < 2) pinchRef.current = undefined;
    const start = pointerStartRef.current;
    pointerStartRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const deltaX = start ? event.clientX - start.x : 0;
    const deltaY = start ? event.clientY - start.y : 0;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    const horizontalPosition = viewportRect ? (event.clientX - viewportRect.left) / Math.max(1, viewportRect.width) : 0;
    const isTap = Boolean(
      !cancelled &&
      start?.immersiveEligible &&
      !wasPinching &&
      Math.abs(deltaX) <= 12 &&
      Math.abs(deltaY) <= 12 &&
      performance.now() - start.at <= 500 &&
      zoom <= 1.02,
    );
    const toggleImmersiveFromViewport = () => {
      suppressViewportClickRef.current = true;
      window.setTimeout(() => {
        suppressViewportClickRef.current = false;
      }, 0);
      toggleImmersive();
    };
    if (continuousView) {
      if (!cancelled && start && !wasPinching && zoom <= 1.02)
        scrollSectionBoundary.onVerticalGesture(start.y - event.clientY, event.pointerType);
      scrollSectionBoundary.onPointerEnd();
      if (isTap && horizontalPosition >= 0.33 && horizontalPosition <= 0.67) toggleImmersiveFromViewport();
      return;
    }
    if (isTap) {
      const step = fixedDocumentTapStep(
        horizontalPosition,
        novel.format === 'image_archive' && comicProfile.direction === 'rtl',
      );
      if (step === 0) toggleImmersiveFromViewport();
      else {
        suppressViewportClickRef.current = true;
        window.setTimeout(() => {
          suppressViewportClickRef.current = false;
        }, 0);
        if (canTurn(step)) turnPage(step);
      }
      return;
    }
    if (!start || wasPinching || zoom > 1.02 || cancelled) return;
    if (Math.abs(deltaX) < 55 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    const rtlComic = novel.format === 'image_archive' && comicProfile.direction === 'rtl';
    turnPage(deltaX < 0 ? (rtlComic ? -1 : 1) : rtlComic ? 1 : -1);
  };
  const handleViewportScroll = () => {
    scrollSectionBoundary.onScroll();
    if (!continuousView || viewportScrollFrameRef.current !== undefined) return;
    viewportScrollFrameRef.current = window.requestAnimationFrame(() => {
      viewportScrollFrameRef.current = undefined;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const nearestVirtualIndex = continuousPageNearestViewportCenter(
        continuousVirtualizer.getVirtualItems(),
        viewport.scrollTop,
        viewport.clientHeight,
      );
      const nearest = stableComicFlow
        ? comicFlow.nearestPage()
        : nearestVirtualIndex === undefined
          ? undefined
          : continuousPageIndexes[nearestVirtualIndex];
      if (nearest === undefined) return;
      observePage(nearest);
    });
  };
  const rtlComic = novel.format === 'image_archive' && comicProfile.direction === 'rtl';
  const currentSpreadIndex = comicSpreadForPage(comicSpreads, pageIndex);
  const canTurn = (step: -1 | 1) =>
    effectiveViewMode === 'spread' && novel.format === 'image_archive'
      ? currentSpreadIndex + step >= 0 && currentSpreadIndex + step < comicSpreads.length
      : pageIndex + step >= 0 && pageIndex + step < totalPages;
  const leftTurnStep: -1 | 1 = rtlComic ? 1 : -1;
  const rightTurnStep: -1 | 1 = rtlComic ? -1 : 1;

  return (
    <main
      className={uiNextKitClass(
        `fixed-doc-screen${novel.format === 'image_archive' ? ' is-comic' : ''}${immersive ? ' is-immersive' : ''}`,
      )}
    >
      <header className="fixed-doc-header">
        <div className="fixed-doc-title-group">
          <button
            type="button"
            className="fixed-doc-icon-button"
            onClick={() => void flushReadingProgress().then(onBack)}
            aria-label="라이브러리로 돌아가기"
          >
            <ArrowLeft size={19} />
          </button>
          <div>
            <strong>{novel.title}</strong>
            {currentDocumentSection && (
              <small className="fixed-doc-mobile-section-label">
                {mobileComicSectionLabel(currentDocumentSection.title)}
              </small>
            )}
            <span>
              {bookFormatLabel(novel)} ·{' '}
              {documentSections.length > 0 ? `${documentSections.length.toLocaleString()}개 회차 · ` : ''}
              {totalPages.toLocaleString()}페이지
            </span>
          </div>
          {documentSections.length > 0 && (
            <label className="fixed-doc-section-select">
              <span>회차</span>
              <select
                value={currentDocumentSection?.id ?? documentSections[0]?.id}
                aria-label="웹툰 회차"
                onChange={(event) => {
                  const section = documentSections.find((candidate) => candidate.id === event.target.value);
                  if (section) goToPage(section.startPageIndex);
                }}
              >
                {documentSections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title} · {section.pageCount}페이지
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="fixed-doc-toolbar" aria-label="문서 보기 설정">
          {novel.format === 'image_archive' && (
            <button
              type="button"
              title="자동 읽기"
              onClick={() => {
                autoReading.stop();
                setAutoReadingOpen(true);
              }}
            >
              <Play size={17} />
            </button>
          )}
          {novel.format === 'image_archive' && (
            <button type="button" title="현재 화면 다시 불러오기" onClick={() => archiveImages.retry()}>
              <RefreshCw size={17} />
            </button>
          )}
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setSidebarOpen((open) => !open))}
            aria-pressed={sidebarOpen}
            title="페이지 목록"
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          {novel.format !== 'image_archive' && (
            <button
              type="button"
              onClick={() =>
                preserveFocalPoint(() => setViewMode((mode) => (mode === 'single' ? 'continuous' : 'single')))
              }
              aria-pressed={viewMode !== 'single'}
              aria-label="연속 보기"
              title="연속 보기"
            >
              <Columns3 size={17} />
            </button>
          )}
          {novel.format === 'image_archive' && (
            <button
              type="button"
              className="fixed-doc-mobile-top-action"
              onClick={() => {
                setComicSettingsOpen((open) => !open);
                setMobileMenuOpen(false);
              }}
              aria-pressed={comicSettingsOpen}
              aria-label="만화 보기 설정"
              title="만화 보기 설정"
            >
              <Settings2 size={17} />
            </button>
          )}
          {novel.format === 'pdf' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSearchOpen((open) => !open);
                  setAnnotationOpen(false);
                }}
                aria-pressed={searchOpen}
                title="PDF 본문 검색"
              >
                <Search size={17} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode((enabled) => !enabled);
                  setRegionMode(false);
                  setPendingRegionSelection(undefined);
                }}
                aria-pressed={selectionMode}
                title="텍스트 선택·복사"
              >
                <TextCursorInput size={17} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setRegionMode((enabled) => !enabled);
                  setSelectionMode(false);
                  setPendingTextSelection(undefined);
                  window.getSelection()?.removeAllRanges();
                }}
                aria-pressed={regionMode}
                title="영역 하이라이트·메모"
              >
                <Highlighter size={17} />
              </button>
              <button
                type="button"
                onClick={() => void onStartListening?.(pageIndex)}
                disabled={!textBlocksByPage.get(pageIndex)?.length}
                title="현재 페이지부터 듣기"
              >
                <Play size={17} />
              </button>
              {onPrepareListening && (
                <button
                  type="button"
                  onClick={() => {
                    setListeningRangeStart(pageIndex + 1);
                    setListeningRangeEnd(Math.min(totalPages, pageIndex + 10));
                    setListeningPreparationOpen((open) => !open);
                    setSearchOpen(false);
                    setAnnotationOpen(false);
                  }}
                  aria-pressed={listeningPreparationOpen}
                  title="PDF 오프라인 음성 준비"
                >
                  <Download size={17} />
                </button>
              )}
              <button
                type="button"
                onClick={() => void togglePageBookmark()}
                aria-pressed={currentPageBookmarked}
                title="현재 페이지 북마크"
              >
                <Bookmark size={17} fill={currentPageBookmarked ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setAnnotationOpen((open) => !open);
                  setSearchOpen(false);
                }}
                aria-pressed={annotationOpen}
                title="PDF 북마크·메모 목록"
              >
                <StickyNote size={17} />
              </button>
            </>
          )}
          <i />
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setZoom((value) => Math.max(0.5, value - 0.1)))}
            aria-label="축소"
          >
            <Minus size={17} />
          </button>
          <span className="fixed-doc-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setZoom((value) => Math.min(3, value + 0.1)))}
            aria-label="확대"
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            onClick={() => {
              preserveFocalPoint(() => {
                setFit('page');
                setZoom(1);
              });
              if (novel.format === 'image_archive') updateComicProfile({ fit: 'page' });
            }}
            aria-pressed={fit === 'page'}
            title="페이지 맞춤"
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            onClick={() => {
              preserveFocalPoint(() => {
                setFit('width');
                setZoom(1);
              });
              if (novel.format === 'image_archive') updateComicProfile({ fit: 'width' });
            }}
            aria-pressed={fit === 'width'}
            title="너비 맞춤"
          >
            <Expand size={17} />
          </button>
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setRotation((value) => (value + 90) % 360))}
            title="회전"
          >
            <RotateCw size={17} />
          </button>
          <button
            type="button"
            className={novel.format === 'image_archive' ? 'fixed-doc-mobile-top-action' : undefined}
            onClick={() => void toggleFullscreen()}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? '전체 화면 종료' : '전체 화면 시작'}
            title="전체 화면"
          >
            {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            className="fixed-doc-mobile-menu-button"
            onClick={() => {
              const next = !mobileMenuOpen;
              if (next) {
                setSearchOpen(false);
                setAnnotationOpen(false);
                setComicSettingsOpen(false);
                setListeningPreparationOpen(false);
                setMobileThumbnailOpen(false);
              }
              setMobileMenuOpen(next);
            }}
            aria-expanded={mobileMenuOpen}
            aria-controls="fixed-doc-mobile-menu"
            title="문서 메뉴"
          >
            <MoreHorizontal size={19} />
          </button>
        </div>
        <form
          className="fixed-doc-page-input"
          onSubmit={(event) => {
            event.preventDefault();
            const targetPage = parseFixedDocumentPageDraft(pageDraft, totalPages);
            if (targetPage === undefined) setPageDraft(String(pageIndex + 1));
            else goToPage(targetPage);
          }}
        >
          <input
            value={pageDraft}
            inputMode="numeric"
            aria-label="현재 페이지"
            onChange={(event) => setPageDraft(event.target.value)}
          />
          <span>/ {totalPages.toLocaleString()}</span>
        </form>
      </header>

      <div className={`fixed-doc-workspace${sidebarOpen ? '' : ' is-sidebar-closed'}`}>
        {sidebarOpen && (
          <aside
            ref={sidebarRef}
            className={`fixed-doc-sidebar${mobileThumbnailOpen ? ' is-mobile-open' : ''}`}
            aria-label="페이지 목록"
          >
            {mobileThumbnailOpen && (
              <header className="fixed-doc-mobile-sheet-header">
                <strong>페이지 목록</strong>
                <button type="button" onClick={() => setMobileThumbnailOpen(false)} aria-label="페이지 목록 닫기">
                  <X size={17} />
                </button>
              </header>
            )}
            {(novel.format === 'pdf' || novel.format === 'image_archive') && (
              <div className="fixed-doc-thumbnail-actions">
                <span>
                  {thumbnailBatchProgress
                    ? `미리보기 ${thumbnailBatchProgress.current}/${thumbnailBatchProgress.total}`
                    : thumbnailBatchSummary
                      ? thumbnailBatchSummary.cancelled
                        ? '미리보기 준비 취소됨'
                        : thumbnailBatchSummary.failed > 0
                          ? `완료 · 실패 ${thumbnailBatchSummary.failed}`
                          : '미리보기 준비 완료'
                      : '페이지 미리보기'}
                </span>
                {thumbnailBatchProgress ? (
                  <button type="button" onClick={() => thumbnailBatchControllerRef.current?.abort()}>
                    취소
                  </button>
                ) : persistThumbnails ? (
                  <button
                    type="button"
                    onClick={() => void prepareAllDocumentThumbnails()}
                    disabled={novel.format === 'pdf' ? !pdf : totalPages === 0}
                  >
                    전체 준비
                  </button>
                ) : null}
              </div>
            )}
            <div className="fixed-doc-sidebar-list" style={{ height: sidebarVirtualizer.getTotalSize() }}>
              {sidebarItems.map((item) => {
                const index = item.index;
                const chapter = sortedChapters[index];
                const pdfPage = pdfPages.get(index);
                return (
                  <button
                    key={chapter.id}
                    ref={sidebarVirtualizer.measureElement}
                    data-index={index}
                    type="button"
                    className={`${index === pageIndex ? 'is-active' : ''}${
                      documentAnnotations.some(
                        (annotation) => annotation.pageIndex === index && annotation.type === 'page_bookmark',
                      )
                        ? ' has-bookmark'
                        : ''
                    }`}
                    style={{ transform: `translateY(${item.start}px)` }}
                    onClick={() => {
                      goToPage(index);
                      setMobileThumbnailOpen(false);
                    }}
                  >
                    <span className="fixed-doc-thumb-placeholder">
                      {novel.format === 'pdf' && pdfPage ? (
                        <PdfThumbnailPreview
                          page={pdfPage}
                          bookId={novel.id}
                          pageIndex={index}
                          pageHash={pdfPageHash(novel, index)}
                        />
                      ) : novel.format === 'image_archive' ? (
                        <ArchiveThumbnailPreview
                          persistent={persistThumbnails}
                          bookId={novel.id}
                          sourceIdentity={archivePageSourceIdentity(
                            chapter,
                            novel.activeContentRevisionId ?? novel.sourceContentHash ?? novel.rawTextHash,
                          )}
                          chapterId={chapter.id}
                          pageIndex={index}
                          repository={repository}
                          assets={assets}
                          onPageHint={recordComicPageHint}
                        />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <em>
                      {index + 1}페이지
                      {comicPageTypeLabel(comicPageHints.get(index)?.type)
                        ? ` · ${comicPageTypeLabel(comicPageHints.get(index)?.type)}`
                        : ''}
                      {comicPageHints.get(index)?.doublePage ? ' · 양면 원고' : ''}
                    </em>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        <section
          className={`fixed-doc-viewport is-${fit} is-${effectiveViewMode} is-bg-${comicProfile.background ?? 'charcoal'}${pageTurnDirection ? ` is-page-turn-${pageTurnDirection > 0 ? 'next' : 'previous'} motion-${comicProfile.pageTurnMotion ?? 'slide'}` : ''}`}
          ref={viewportRef}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={(event) => pointerUp(event, true)}
          onLostPointerCapture={pointerUp}
          onClickCapture={(event) => {
            if (!suppressViewportClickRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressViewportClickRef.current = false;
          }}
          onScroll={handleViewportScroll}
          onWheel={(event) => {
            scrollSectionBoundary.onWheel(event);
            if (!event.ctrlKey) return;
            event.preventDefault();
            preserveFocalPoint(
              () => setZoom((value) => Math.max(0.5, Math.min(3, value - event.deltaY * 0.002))),
              event.clientX,
              event.clientY,
            );
          }}
          onDoubleClick={(event) => {
            if (continuousView) {
              event.preventDefault();
              return;
            }
            preserveFocalPoint(() => setZoom((value) => (value > 1.02 ? 1 : 2)), event.clientX, event.clientY);
          }}
          aria-busy={documentStatus === 'loading' || remoteNavigation?.busy}
        >
          {documentStatus === 'failed' && !stableComicFlow ? (
            <div className="fixed-doc-message">
              <strong>문서를 열지 못했습니다.</strong>
              <span>{archiveError ?? errorMessage}</span>
              {novel.format === 'image_archive' && (
                <button
                  type="button"
                  className="secondary-btn"
                  aria-label={`${pageIndex + 1}페이지 다시 불러오기`}
                  onClick={() => archiveImages.retry(pageIndex)}
                >
                  <RefreshCw size={16} /> 다시 불러오기
                </button>
              )}
            </div>
          ) : (
            <ComicPageFlow
              enabled={stableComicFlow}
              geometry={imageDimensions}
              sectionKey={continuousSectionKey}
              viewportRef={viewportRef}
              contentRef={continuousContentRef}
              className={`fixed-doc-pages${stableComicFlow ? ' is-page-flow' : continuousView ? ' is-virtual' : ''}`}
              style={
                continuousView && !stableComicFlow
                  ? {
                      ...pageStyle,
                      height: continuousVirtualizer.getTotalSize() + continuousSectionFooterHeight,
                    }
                  : pageStyle
              }
            >
              {displayedPages.map((index) => (
                <article
                  key={sortedChapters[index]?.id ?? index}
                  ref={
                    continuousView &&
                    !stableComicFlow &&
                    (novel.format !== 'image_archive' ||
                      (archiveImages.pages.has(index) && imageDimensions.has(sortedChapters[index]?.id ?? '')))
                      ? continuousVirtualizer.measureElement
                      : undefined
                  }
                  data-index={continuousVirtualIndexByPage.get(index) ?? index}
                  data-page-index={index}
                  className={`${index === pageIndex ? 'is-current' : ''}${effectiveViewMode === 'spread' ? ' is-spread-page' : ''}${effectiveViewMode === 'spread' && comicSpreads[comicSpreadForPage(comicSpreads, pageIndex)]?.widePage === index ? ' is-double-page' : ''}`}
                  style={
                    stableComicFlow
                      ? ({
                          height: estimateContinuousPageSize(index),
                          '--fixed-doc-seamless-page-width': `${seamlessContinuousPageWidth(index)}px`,
                        } as CSSProperties)
                      : continuousView
                        ? ({
                            transform: `translateY(${
                              continuousItems.find((item) => item.index === continuousVirtualIndexByPage.get(index))
                                ?.start ?? 0
                            }px)`,
                            ...(!seamlessContinuousView &&
                            novel.format === 'image_archive' &&
                            (!archiveImages.pages.has(index) || !imageDimensions.has(sortedChapters[index]?.id ?? ''))
                              ? {
                                  height:
                                    continuousItems.find((item) => item.key === sortedChapters[index]?.id)?.size ??
                                    estimateContinuousPageSize(index),
                                }
                              : {}),
                            ...(seamlessContinuousView
                              ? {
                                  height: estimateContinuousPageSize(index),
                                  '--fixed-doc-seamless-page-width': `${seamlessContinuousPageWidth(index)}px`,
                                }
                              : {}),
                          } as CSSProperties)
                        : undefined
                  }
                  aria-label={`${index + 1}페이지`}
                  onClick={index !== pageIndex ? () => goToPage(index) : undefined}
                >
                  {novel.format === 'pdf' && pdfPages.get(index) ? (
                    <PdfPageView
                      page={pdfPages.get(index)}
                      fit={fit}
                      zoom={zoom}
                      rotation={rotation}
                      availableWidth={Math.max(240, viewportSize.width - 72)}
                      availableHeight={Math.max(320, viewportSize.height - 72)}
                      pageIndex={index}
                      textBlocks={textBlocksByPage.get(index)}
                      selectionEnabled={selectionMode}
                      searchQuery={searchOpen ? searchQuery : ''}
                      annotations={documentAnnotations.filter((annotation) => annotation.pageIndex === index)}
                      onTextSelection={setPendingTextSelection}
                      regionSelectionEnabled={regionMode}
                      onRegionSelection={setPendingRegionSelection}
                      activeRange={
                        listeningPosition?.anchor.kind === 'fixed_text'
                          ? {
                              blockId: listeningPosition.anchor.blockId,
                              startOffset: listeningPosition.anchor.startOffset,
                              endOffset: listeningPosition.anchor.endOffset,
                            }
                          : undefined
                      }
                    />
                  ) : novel.format === 'pdf' ? (
                    <div className="fixed-doc-page-loading">{index + 1}페이지 불러오는 중</div>
                  ) : archiveImages.pages.get(index)?.url ? (
                    <img
                      src={archiveImages.pages.get(index)?.url}
                      alt={`${novel.title} ${index + 1}페이지`}
                      draggable={false}
                      onError={(event) => archiveImages.reportError(index, event.currentTarget.src)}
                      width={imageDimensions.get(sortedChapters[index]?.id ?? '')?.width}
                      height={imageDimensions.get(sortedChapters[index]?.id ?? '')?.height}
                      onLoad={(event) =>
                        recordArchiveImageDimensions(index, {
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        })
                      }
                      style={
                        comicProfile.crop === 'auto' && comicProfile.pageCrops?.[String(index)]
                          ? ({
                              '--fixed-doc-image-clip': Object.values(comicProfile.pageCrops[String(index)]).some(
                                (value) => value > 0,
                              )
                                ? undefined
                                : 'none',
                              '--fixed-doc-crop-top': `${comicProfile.pageCrops[String(index)].top * 100}%`,
                              '--fixed-doc-crop-right': `${comicProfile.pageCrops[String(index)].right * 100}%`,
                              '--fixed-doc-crop-bottom': `${comicProfile.pageCrops[String(index)].bottom * 100}%`,
                              '--fixed-doc-crop-left': `${comicProfile.pageCrops[String(index)].left * 100}%`,
                              '--fixed-doc-crop-scale': comicCropRefitScale(comicProfile.pageCrops[String(index)], fit),
                            } as CSSProperties)
                          : comicProfile.crop === 'auto'
                            ? ({ '--fixed-doc-image-clip': 'none' } as CSSProperties)
                            : undefined
                      }
                    />
                  ) : (
                    <div
                      className="fixed-doc-page-loading"
                      style={seamlessContinuousView ? { height: estimateContinuousPageSize(index) } : undefined}
                    >
                      <div className="fixed-doc-page-retry">
                        <span role="status">{archiveImages.errors.get(index) ?? `${index + 1}페이지 불러오는 중`}</span>
                        {archiveImages.errors.has(index) ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            aria-label={`${index + 1}페이지 다시 불러오기`}
                            onClick={(event) => {
                              event.stopPropagation();
                              archiveImages.retry(index);
                            }}
                          >
                            <RefreshCw size={16} /> 다시 불러오기
                          </button>
                        ) : (
                          <span className="fixed-doc-loading-spinner" aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {continuousView && currentDocumentSection && (
                <div
                  className="fixed-doc-section-footer"
                  style={{
                    height: continuousSectionFooterHeight,
                    ...(stableComicFlow
                      ? { position: 'relative' }
                      : { transform: `translateY(${continuousVirtualizer.getTotalSize()}px)` }),
                  }}
                >
                  <nav className="fixed-doc-section-nav" aria-label="만화 회차 이동">
                    <button
                      type="button"
                      disabled={!hasPreviousSection || remoteNavigation?.busy}
                      onClick={() => {
                        navigateSection(-1);
                      }}
                    >
                      <ChevronLeft size={16} /> 이전 회차
                    </button>
                    <button
                      type="button"
                      disabled={!hasNextSection || remoteNavigation?.busy}
                      onClick={() => {
                        navigateSection(1);
                      }}
                    >
                      다음 회차 <ChevronRight size={16} />
                    </button>
                  </nav>
                  {hasNextSection && (
                    <div
                      className={`fixed-doc-next-section-boundary${scrollSectionBoundary.armed ? ' is-armed' : ''}`}
                      aria-live="polite"
                    >
                      <span>다음 회차</span>
                      <strong>{nextDocumentSection?.title ?? remoteNavigation?.nextTitle ?? '다음 회차'}</strong>
                      <small>{scrollSectionBoundary.armed ? '한 번 더 아래로 스크롤' : '마지막까지 읽었습니다'}</small>
                    </div>
                  )}
                </div>
              )}
            </ComicPageFlow>
          )}
          <button
            type="button"
            className="fixed-doc-turn is-previous"
            onClick={() => turnPage(leftTurnStep)}
            disabled={!canTurn(leftTurnStep)}
            aria-label={leftTurnStep === 1 ? '다음 페이지' : '이전 페이지'}
          >
            <ChevronLeft size={28} />
          </button>
          <button
            type="button"
            className="fixed-doc-turn is-next"
            onClick={() => turnPage(rightTurnStep)}
            disabled={!canTurn(rightTurnStep)}
            aria-label={rightTurnStep === 1 ? '다음 페이지' : '이전 페이지'}
          >
            <ChevronRight size={28} />
          </button>
        </section>
      </div>
      <AutoScrollControls
        controller={autoReading}
        open={autoReadingOpen}
        allowed={autoReadingAllowed && documentStatus === 'ready' && autoReading.modeAllowed}
        onClose={() => setAutoReadingOpen(false)}
      />
      {mobileMenuOpen && (
        <aside
          id="fixed-doc-mobile-menu"
          className="fixed-doc-search-panel fixed-doc-mobile-menu"
          aria-label="모바일 문서 메뉴"
        >
          <header>
            <h3>문서 보기</h3>
            <button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="문서 메뉴 닫기">
              <X size={16} />
            </button>
          </header>
          <div className="fixed-doc-mobile-actions">
            {novel.format === 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  autoReading.stop();
                  setMobileMenuOpen(false);
                  setAutoReadingOpen(true);
                }}
              >
                <Play size={16} /> 자동 읽기
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSidebarOpen(true);
                setMobileThumbnailOpen(true);
                setMobileMenuOpen(false);
              }}
            >
              <PanelLeftOpen size={16} /> 페이지 목록
            </button>
            {novel.format === 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  archiveImages.retry();
                  setMobileMenuOpen(false);
                }}
              >
                <RefreshCw size={16} /> 현재 화면 다시 불러오기
              </button>
            )}
            {novel.format !== 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  preserveFocalPoint(() => setViewMode((mode) => (mode === 'single' ? 'continuous' : 'single')));
                  setMobileMenuOpen(false);
                }}
              >
                <Columns3 size={16} /> 보기 전환
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => {
                  setFit('page');
                  setZoom(1);
                });
                if (novel.format === 'image_archive') updateComicProfile({ fit: 'page' });
                setMobileMenuOpen(false);
              }}
            >
              <Maximize2 size={16} /> 페이지 맞춤
            </button>
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => {
                  setFit('width');
                  setZoom(1);
                });
                if (novel.format === 'image_archive') updateComicProfile({ fit: 'width' });
                setMobileMenuOpen(false);
              }}
            >
              <Expand size={16} /> 너비 맞춤
            </button>
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => setRotation((value) => (value + 90) % 360));
                setMobileMenuOpen(false);
              }}
            >
              <RotateCw size={16} /> 회전
            </button>
            {novel.format !== 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  void toggleFullscreen();
                  setMobileMenuOpen(false);
                }}
              >
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                {fullscreen ? '전체 화면 종료' : '전체 화면'}
              </button>
            )}
            {novel.format === 'pdf' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(true);
                    setAnnotationOpen(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <Search size={16} /> 본문 검색·OCR
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectionMode(true);
                    setRegionMode(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <TextCursorInput size={16} /> 텍스트 선택
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRegionMode(true);
                    setSelectionMode(false);
                    setPendingTextSelection(undefined);
                    window.getSelection()?.removeAllRanges();
                    setMobileMenuOpen(false);
                  }}
                >
                  <Highlighter size={16} /> 영역 하이라이트·메모
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void togglePageBookmark();
                    setMobileMenuOpen(false);
                  }}
                >
                  <Bookmark size={16} fill={currentPageBookmarked ? 'currentColor' : 'none'} />
                  {currentPageBookmarked ? '현재 북마크 해제' : '현재 페이지 북마크'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnnotationOpen(true);
                    setSearchOpen(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <StickyNote size={16} /> 북마크·메모
                </button>
                <button
                  type="button"
                  disabled={!textBlocksByPage.get(pageIndex)?.length}
                  onClick={() => {
                    void onStartListening?.(pageIndex);
                    setMobileMenuOpen(false);
                  }}
                >
                  <Play size={16} /> 현재 페이지부터 듣기
                </button>
                {onPrepareListening && (
                  <button
                    type="button"
                    onClick={() => {
                      setListeningRangeStart(pageIndex + 1);
                      setListeningRangeEnd(Math.min(totalPages, pageIndex + 10));
                      setListeningPreparationOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Download size={16} /> 오프라인 음성 준비
                  </button>
                )}
              </>
            )}
          </div>
        </aside>
      )}
      {pendingTextSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="선택한 PDF 텍스트 작업">
          <span title={pendingTextSelection.quote}>{pendingTextSelection.quote}</span>
          {reanchorTargetId ? (
            <button
              type="button"
              onClick={() => void manuallyReanchorAnnotation()}
              disabled={
                documentAnnotations.find((annotation) => annotation.id === reanchorTargetId)?.pageIndex !==
                pendingTextSelection.pageIndex
              }
            >
              <TextCursorInput size={15} />
              {documentAnnotations.find((annotation) => annotation.id === reanchorTargetId)?.pageIndex ===
              pendingTextSelection.pageIndex
                ? '기존 주석에 다시 연결'
                : '원래 페이지에서 선택하세요'}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void saveTextAnnotation('text_highlight')}>
                <Highlighter size={15} /> 하이라이트
              </button>
              <button
                type="button"
                onClick={() => {
                  const first = pendingTextSelection.ranges[0];
                  if (!first) return;
                  setPendingTextSelection(undefined);
                  window.getSelection()?.removeAllRanges();
                  void onStartListening?.(pendingTextSelection.pageIndex, first.block.id, first.startOffset);
                }}
              >
                <Play size={15} /> 여기부터 듣기
              </button>
              <label>
                <StickyNote size={15} aria-hidden="true" />
                <input
                  value={selectionNoteDraft}
                  onChange={(event) => setSelectionNoteDraft(event.target.value)}
                  placeholder="메모 (선택)"
                  aria-label="선택한 텍스트 메모"
                />
              </label>
              <button type="button" onClick={() => void saveTextAnnotation('text_note')}>
                메모 저장
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setPendingTextSelection(undefined);
              setReanchorTargetId(undefined);
              window.getSelection()?.removeAllRanges();
            }}
            aria-label="선택 작업 닫기"
          >
            <X size={15} />
          </button>
        </aside>
      )}
      {reanchorTargetId && !pendingTextSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="PDF 주석 다시 연결">
          <span>기존 주석의 새 위치가 될 텍스트를 선택하세요.</span>
          <button
            type="button"
            onClick={() => {
              setReanchorTargetId(undefined);
              setSelectionMode(false);
              window.getSelection()?.removeAllRanges();
            }}
          >
            다시 연결 취소
          </button>
        </aside>
      )}
      {pendingRegionSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="선택한 PDF 영역 작업">
          <span>{pendingRegionSelection.pageIndex + 1}페이지 영역</span>
          <button type="button" onClick={() => void saveRegionAnnotation('region_highlight')}>
            <Highlighter size={15} /> 하이라이트
          </button>
          <label>
            <StickyNote size={15} aria-hidden="true" />
            <input
              value={regionNoteDraft}
              onChange={(event) => setRegionNoteDraft(event.target.value)}
              placeholder="영역 메모 (선택)"
              aria-label="선택한 영역 메모"
            />
          </label>
          <button type="button" onClick={() => void saveRegionAnnotation('region_note')}>
            메모 저장
          </button>
          <button type="button" onClick={() => setPendingRegionSelection(undefined)} aria-label="영역 작업 닫기">
            <X size={15} />
          </button>
        </aside>
      )}
      {listeningPreparationOpen && novel.format === 'pdf' && onPrepareListening && (
        <aside className="fixed-doc-search-panel fixed-doc-listening-panel" aria-label="PDF 오프라인 음성 준비">
          <header>
            <h3>오프라인 음성 준비</h3>
            <button
              type="button"
              onClick={() => setListeningPreparationOpen(false)}
              aria-label="오프라인 음성 준비 닫기"
            >
              <X size={16} />
            </button>
          </header>
          <p>본문 또는 OCR이 준비된 페이지만 저장합니다. 한 번에 최대 50페이지를 처리합니다.</p>
          <div className="fixed-doc-listening-range">
            <label>
              <span>시작</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={listeningRangeStart}
                onChange={(event) => setListeningRangeStart(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
              />
            </label>
            <span>–</span>
            <label>
              <span>끝</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={listeningRangeEnd}
                onChange={(event) => setListeningRangeEnd(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
              />
            </label>
          </div>
          <div className="fixed-doc-listening-actions">
            {listeningPreparationBusy ? (
              <button type="button" className="is-cancel" onClick={onCancelListeningPreparation}>
                준비 취소
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void onPrepareListening(pageIndex, pageIndex)}>
                  현재 페이지
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void onPrepareListening(
                      Math.min(listeningRangeStart, listeningRangeEnd) - 1,
                      Math.min(
                        totalPages,
                        Math.min(listeningRangeStart, listeningRangeEnd) + 49,
                        Math.max(listeningRangeStart, listeningRangeEnd),
                      ) - 1,
                    )
                  }
                >
                  선택 범위 준비
                </button>
              </>
            )}
          </div>
        </aside>
      )}
      {comicSettingsOpen && novel.format === 'image_archive' && (
        <Suspense fallback={null}>
          <UiNextComicSettings
            viewMode={viewMode}
            profile={comicProfile}
            narrow={viewportSize.width < 720}
            pageIndex={pageIndex}
            totalPages={totalPages}
            crop={{
              progress: comicCropProgress,
              status: comicCropStatus,
              failedPages: comicCropFailedPages,
              run: (indexes) => void autoCropPages(indexes),
              cancel: () => comicCropControllerRef.current?.abort(),
            }}
            onViewMode={changeComicViewMode}
            onFit={changeComicFit}
            update={updateComicProfile}
            onClose={() => setComicSettingsOpen(false)}
          />
        </Suspense>
      )}

      {annotationOpen && novel.format === 'pdf' && (
        <aside className="fixed-doc-search-panel fixed-doc-annotation-panel" aria-label="PDF 북마크와 메모">
          <header>
            <h3>북마크·표시</h3>
            <button type="button" onClick={() => setAnnotationOpen(false)} aria-label="북마크와 메모 닫기">
              <X size={16} />
            </button>
          </header>
          {documentAnnotations.length === 0 ? (
            <p className="fixed-doc-search-empty">저장한 북마크나 표시가 없습니다.</p>
          ) : (
            <div className="fixed-doc-annotation-list">
              {documentAnnotations.map((annotation) => (
                <div
                  key={annotation.id}
                  className={annotation.textAnchorRemap?.status === 'needs_review' ? 'has-reanchor' : undefined}
                >
                  <button
                    type="button"
                    className={
                      `${annotation.pageIndex === pageIndex ? 'is-active' : ''}${annotation.textAnchorRemap?.status === 'needs_review' ? ' is-remap-review' : ''}`.trim() ||
                      undefined
                    }
                    onClick={() => goToPage(annotation.pageIndex)}
                  >
                    <span>
                      {annotation.type === 'page_bookmark'
                        ? '북마크'
                        : annotation.type.includes('note')
                          ? '메모'
                          : '하이라이트'}{' '}
                      · {annotation.pageIndex + 1}페이지
                    </span>
                    <strong>{annotation.body || annotation.quote || `${annotation.pageIndex + 1}페이지`}</strong>
                  </button>
                  {annotation.textAnchorRemap?.status === 'needs_review' && annotation.anchor.kind === 'fixed_text' && (
                    <button
                      type="button"
                      className="is-reanchor"
                      onClick={() => {
                        goToPage(annotation.pageIndex);
                        setReanchorTargetId(annotation.id);
                        setSelectionMode(true);
                        setRegionMode(false);
                        setPendingTextSelection(undefined);
                        setAnnotationOpen(false);
                        window.getSelection()?.removeAllRanges();
                      }}
                      aria-label={`${annotation.pageIndex + 1}페이지 주석 다시 연결`}
                      title="새 텍스트 위치 선택"
                    >
                      <TextCursorInput size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeDocumentAnnotation(annotation.id)}
                    aria-label={`${annotation.pageIndex + 1}페이지 표시 삭제`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
      {searchOpen && novel.format === 'pdf' && (
        <aside
          className={`fixed-doc-search-panel${readingOrderOpen ? ' is-reading-order' : ''}`}
          aria-label="PDF 본문 검색"
        >
          <header>
            <label>
              <Search size={15} aria-hidden="true" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="PDF 본문 검색"
                aria-label="PDF 본문 검색어"
              />
            </label>
            <button type="button" onClick={() => setSearchOpen(false)} aria-label="검색 닫기">
              <X size={16} />
            </button>
          </header>
          <div className="fixed-doc-search-coverage">
            <span>
              검색 가능 {readyTextPages.toLocaleString()} / {totalPages.toLocaleString()}페이지
            </span>
            {textIndexProgress ? (
              <button type="button" onClick={cancelIndex}>
                준비 중 {textIndexProgress.current}/{textIndexProgress.total} · 취소
              </button>
            ) : readyTextPages < totalPages ? (
              <button type="button" onClick={() => void indexAllPdfText()}>
                전체 텍스트 준비
              </button>
            ) : null}
          </div>
          <button
            className="fixed-doc-reading-order-entry"
            type="button"
            onClick={() => void openReadingOrderEditor()}
            disabled={readingOrderStatus === 'loading' || readingOrderStatus === 'saving'}
          >
            <ListOrdered size={15} aria-hidden="true" />
            <span>
              <strong>현재 페이지 읽기 순서</strong>
              <small>검색·복사·TTS에 공통 적용</small>
            </span>
          </button>
          {readingOrderOpen && (
            <section className="fixed-doc-reading-order" aria-label="현재 페이지 읽기 순서 교정">
              <header>
                <div>
                  <strong>{pageIndex + 1}페이지 읽기 순서</strong>
                  <span>위에서 아래로 재생됩니다. 머리말·꼬리말은 제외할 수 있습니다.</span>
                </div>
                <button type="button" onClick={() => setReadingOrderOpen(false)} aria-label="읽기 순서 닫기">
                  <X size={15} />
                </button>
              </header>
              {readingOrderStatus === 'loading' ? (
                <p aria-live="polite">텍스트 블록을 불러오는 중…</p>
              ) : readingOrderBlocks.length > 0 ? (
                <div className="fixed-doc-reading-order-list">
                  {readingOrderBlocks.map((block, index) => {
                    const excluded = readingOrderExcludedIds.has(block.id);
                    return (
                      <article key={block.id} className={excluded ? 'is-excluded' : undefined}>
                        <span>{index + 1}</span>
                        <div>
                          <small>{block.role.replace('_', ' ')}</small>
                          <strong>{block.text.replace(/\s+/g, ' ').trim() || '(빈 블록)'}</strong>
                        </div>
                        <nav aria-label={`${index + 1}번 블록 순서 조정`}>
                          <button
                            type="button"
                            onClick={() => moveReadingOrderBlock(index, -1)}
                            disabled={index === 0}
                            aria-label="한 칸 위로"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveReadingOrderBlock(index, 1)}
                            disabled={index === readingOrderBlocks.length - 1}
                            aria-label="한 칸 아래로"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className={excluded ? 'is-active' : undefined}
                            onClick={() => toggleReadingOrderExcluded(block.id)}
                            aria-label={excluded ? '읽기 순서에 다시 포함' : '검색과 TTS에서 제외'}
                            aria-pressed={excluded}
                          >
                            <EyeOff size={14} />
                          </button>
                        </nav>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p aria-live="polite">{readingOrderError || '교정할 텍스트 블록이 없습니다.'}</p>
              )}
              {readingOrderError && readingOrderBlocks.length > 0 && <p role="alert">{readingOrderError}</p>}
              <footer>
                <button
                  type="button"
                  onClick={() => void resetReadingOrder()}
                  disabled={!readingOrderRevision || readingOrderStatus === 'saving'}
                >
                  자동 순서로 초기화
                </button>
                <button type="button" onClick={() => setReadingOrderOpen(false)}>
                  취소
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void saveReadingOrder()}
                  disabled={!readingOrderRevision || readingOrderStatus === 'saving'}
                >
                  {readingOrderStatus === 'saving' ? '저장 중…' : '적용'}
                </button>
              </footer>
            </section>
          )}
          <div className="fixed-doc-ocr-range">
            <div>
              <label>
                <span>OCR 시작</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={ocrRangeStart}
                  onChange={(event) => setOcrRangeStart(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
                />
              </label>
              <span>–</span>
              <label>
                <span>끝</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={ocrRangeEnd}
                  onChange={(event) => setOcrRangeEnd(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
                />
              </label>
            </div>
            <select
              value={ocrLanguage}
              onChange={(event) => setOcrLanguage(event.target.value)}
              aria-label="범위 OCR 언어"
            >
              <option value="kor+eng">한국어 + 영어</option>
              <option value="jpn+eng">일본어 + 영어</option>
              <option value="eng">영어</option>
            </select>
            <button
              type="button"
              onClick={() => void runOcrRange()}
              disabled={Boolean(textIndexProgress || ocrProgress)}
            >
              낮은 품질 페이지만 범위 OCR
            </button>
            {ocrWorkerLanguage && !ocrProgress && (
              <button type="button" onClick={() => void unloadOcrWorker()}>
                OCR 메모리 해제 · {ocrWorkerLanguage}
              </button>
            )}
          </div>
          <section className="fixed-doc-ocr-models" aria-labelledby="fixed-doc-ocr-models-title">
            <header>
              <div>
                <strong id="fixed-doc-ocr-models-title">OCR 언어 데이터</strong>
                <span>인식할 때 내려받아 이 기기에 보관합니다.</span>
              </div>
              <button
                type="button"
                onClick={() => void refreshOcrModelCache()}
                disabled={ocrModelCacheStatus === 'loading' || Boolean(ocrProgress)}
              >
                새로고침
              </button>
            </header>
            {ocrModelCacheStatus === 'loading' ? (
              <p aria-live="polite">저장 상태 확인 중…</p>
            ) : ocrModelCacheStatus === 'failed' ? (
              <p role="alert">{ocrModelCacheError}</p>
            ) : ocrModelCache.some((entry) => entry.installed) ? (
              <ul>
                {ocrModelCache
                  .filter((entry) => entry.installed)
                  .map((entry) => (
                    <li key={entry.language}>
                      <span>
                        <strong>{OCR_LANGUAGE_LABELS[entry.language]}</strong>
                        <small>{formatStoredBytes(entry.byteLength)}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeOcrModel(entry.language)}
                        disabled={Boolean(ocrProgress)}
                        aria-label={`${OCR_LANGUAGE_LABELS[entry.language]} OCR 언어 데이터 삭제`}
                      >
                        삭제
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>아직 내려받은 언어 데이터가 없습니다.</p>
            )}
            <span className="fixed-doc-ocr-models-supported">
              지원 언어 · {OCR_LANGUAGE_MODELS.map((language) => OCR_LANGUAGE_LABELS[language]).join(' / ')}
            </span>
          </section>
          {(textPageStates.get(pageIndex) === 'ocr_candidate' ||
            textPageStates.get(pageIndex) === 'failed' ||
            ocrProgress ||
            ocrError) && (
            <div className="fixed-doc-ocr-notice">
              {ocrProgress ? (
                <>
                  <span>
                    OCR {ocrProgress.current}/{ocrProgress.total} · {ocrProgress.pageIndex + 1}페이지 ·{' '}
                    {Math.round(ocrProgress.progress * 100)}%
                  </span>
                  <button type="button" onClick={cancelOcr}>
                    취소
                  </button>
                </>
              ) : (
                <>
                  <span>{ocrError || '현재 페이지는 native text 품질이 낮아 OCR이 필요합니다.'}</span>
                  <select
                    value={ocrLanguage}
                    onChange={(event) => setOcrLanguage(event.target.value)}
                    aria-label="OCR 언어"
                  >
                    <option value="kor+eng">한국어 + 영어</option>
                    <option value="jpn+eng">일본어 + 영어</option>
                    <option value="eng">영어</option>
                  </select>
                  <button type="button" onClick={() => void runOcrPages([pageIndex])}>
                    모델 내려받고 현재 페이지 인식
                  </button>
                  {ocrCandidatePages.length > 1 && (
                    <button type="button" onClick={() => void runOcrPages(ocrCandidatePages)}>
                      후보 {ocrCandidatePages.length}페이지 인식
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {searchStatus === 'loading' ? (
            <p className="fixed-doc-search-empty">검색 중…</p>
          ) : searchStatus === 'failed' ? (
            <p className="fixed-doc-search-empty">검색하지 못했습니다.</p>
          ) : searchQuery.trim() && searchResults.length === 0 ? (
            <p className="fixed-doc-search-empty">준비된 페이지에서 결과가 없습니다.</p>
          ) : searchResults.length > 0 ? (
            <>
              <nav className="fixed-doc-search-nav" aria-label="검색 결과 이동">
                <button type="button" onClick={() => jumpToSearchResult(searchCursor - 1)}>
                  이전
                </button>
                <span>
                  {searchCursor + 1} / {searchResults.length}
                </span>
                <button type="button" onClick={() => jumpToSearchResult(searchCursor + 1)}>
                  다음
                </button>
              </nav>
              <div className="fixed-doc-search-results">
                {searchResults.map((result, index) => (
                  <button
                    key={`${result.revisionId}:${result.blockId}:${result.startOffset}`}
                    type="button"
                    className={index === searchCursor ? 'is-active' : undefined}
                    onClick={() => jumpToSearchResult(index)}
                  >
                    <span>{result.pageIndex + 1}페이지</span>
                    <strong>{result.text}</strong>
                    {result.source === 'ocr' && <em>OCR</em>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="fixed-doc-search-empty">검색어를 입력하세요.</p>
          )}
        </aside>
      )}
      {remoteNavigation?.busy && !remoteNavigation.error && (
        <div className="fixed-doc-transition-status" role="status">
          <span className="fixed-doc-loading-spinner" aria-hidden="true" />
          회차 불러오는 중
        </div>
      )}
      {(navigationError || remoteNavigation?.error) && (
        <p className="fixed-doc-navigation-error" role="alert">
          {navigationError || remoteNavigation?.error}
          {remoteNavigation?.error && remoteNavigation.retry && (
            <button type="button" className="secondary-btn" onClick={remoteNavigation.retry}>
              다시 시도
            </button>
          )}
        </p>
      )}
      <footer className={`fixed-doc-footer${novel.format === 'image_archive' ? ' has-chapter-steps' : ''}`}>
        {novel.format === 'image_archive' && (
          <button
            type="button"
            className="fixed-doc-chapter-step"
            disabled={!hasPreviousSection || remoteNavigation?.busy}
            onClick={() => navigateSection(-1)}
            aria-label="이전 회차"
          >
            <ChevronLeft size={15} /> <span>이전 화</span>
          </button>
        )}
        <span>
          {seekWindow.pageNumber} / {seekWindow.pageCount}
        </span>
        {novel.format === 'image_archive' ? (
          <input
            className="fixed-doc-page-seek"
            type="range"
            min={1}
            max={Math.max(1, seekWindow.pageCount)}
            value={seekWindow.pageNumber}
            disabled={seekWindow.pageCount <= 1}
            aria-label="만화 페이지 빠르게 이동"
            aria-valuetext={`${seekWindow.pageNumber} / ${seekWindow.pageCount} 페이지`}
            style={{ '--fixed-doc-progress': `${seekWindow.progressPercent}%` } as CSSProperties}
            onChange={(event) => goToPage(seekWindow.startPageIndex + Number(event.target.value) - 1)}
          />
        ) : (
          <div>
            <i style={{ width: `${seekWindow.progressPercent}%` }} />
          </div>
        )}
        <span>{Math.round(seekWindow.progressPercent)}%</span>
        {novel.format === 'image_archive' && (
          <button
            type="button"
            className="fixed-doc-chapter-step"
            disabled={!hasNextSection || remoteNavigation?.busy}
            onClick={() => navigateSection(1)}
            aria-label="다음 회차"
          >
            <span>다음 화</span> <ChevronRight size={15} />
          </button>
        )}
      </footer>
    </main>
  );
}
