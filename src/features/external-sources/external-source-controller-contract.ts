import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import type { SourceLibraryReader } from './use-source-library-reader';
import type { SourceLibraryMetadataPatch } from './source-library-metadata';
import type { SourceReaderCatalog } from './use-source-reader-catalog';
import type { BatchLibraryItemResult } from '../../repositories/library-catalog-repository';
import type { SourceWorkProgressProjection } from './source-work-progress';
import type { SourceReadingPort } from '../../external-sources/source-text-stream';
import type { DownloadRetention } from './use-download-retention';
import type { SourceDownloadQueue } from '../../external-sources/source-user-state';
import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@boaa/extension-contracts';
import type { Chapter, Novel } from '../../domain/types';
import type {
  ExternalItemSummary,
  ExternalSourceBrowseMode,
  ExternalSourceBrowseState,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceListInput,
  ExternalSourceFilterValue,
  ExternalSourceWorkDetail,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import type {
  ExternalSourceOrigin,
  ExternalSourceRegistryPort,
} from '../../external-sources/app-external-source-registry';
import type {
  ExternalSourceDefaultFolder,
  ExternalSourceLocalState,
  ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { ImportProgress, ImportService } from '../../services/import/import-service';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ToastTone } from '../../shared/ui/toast-controller';
import type { SerialReleaseReadingState } from './serial-work-projection';
import type { ImportTaskView } from '../import/import-task-projection';

export type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';

export interface ExternalSourceView {
  readonly lang?: string;
  readonly contentKind?: 'text' | 'image';
  readonly extensionManager?: import('../../external-sources/extension-management').SourceExtensionManager;
  readonly id: ExtensionContributionId;
  readonly title: string;
  readonly description?: string;
  readonly kind: ExternalSourceContributionDescriptor['kind'];
  readonly origin: ExternalSourceOrigin;
  readonly connection: ExternalSourceConnectionStatus;
  readonly connectionForm?: ExternalSourceConnectionForm;
  readonly supportsSubscriptions?: boolean;
  readonly newReleaseCount?: number;
}

export type ExternalSourceItemImportState = 'available' | 'imported' | 'update_available' | 'unsupported';

export interface ExternalSourceItemView extends ExternalItemSummary {
  readonly originalTitle?: string;
  readonly selected: boolean;
  readonly importState: ExternalSourceItemImportState;
  readonly localBookId?: string;
  readonly localBookTitle?: string;
  readonly readingState?: SerialReleaseReadingState;
  /** Local-only section order must not be compared with remote chapter numbers. */
  readonly localOrderOnly?: boolean;
}

export interface ExternalSourceLibraryWork extends ExternalSourceSubscriptionRecord {
  requestMetadata?(): Promise<void>;
  readonly localBookId?: string;
}

export interface ExternalSourceBreadcrumb {
  readonly label: string;
  readonly parentRef?: string;
}

export interface ExternalSourceImportProgress {
  readonly current: number;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly linkedExisting: number;
  readonly fileName?: string;
  readonly phase?: 'downloading' | 'verifying' | 'importing';
  readonly detail?: ImportProgress;
}

export interface ExternalSourceController {
  readonly downloadRetention?: DownloadRetention;
  renameRelease?(item: ExternalSourceItemView, title: string): Promise<void>;
  setReleasesRead?(items: readonly ExternalSourceItemView[], read: boolean): Promise<void>;
  markPreviousReleasesRead?(item: ExternalSourceItemView): Promise<void>;
  readonly recoverableDownloads?: readonly SourceDownloadQueue[];
  resumeDownloadQueue?(queue: SourceDownloadQueue): Promise<void>;
  discardDownloadQueue?(id: string): Promise<void>;
  readonly autoDownloadNext?: boolean;
  readonly autoDownloadNextCount?: 1 | 2 | 3;
  setAutoDownloadNextCount?(count: 1 | 2 | 3): void;
  setAutoDownloadNext?(enabled: boolean): void;
  captureNavigation?(): ExternalSourceNavigationSnapshot;
  restoreNavigation?(snapshot: ExternalSourceNavigationSnapshot): Promise<void>;
  readonly open: boolean;
  readonly loading: boolean;
  readonly catalogLoading?: boolean;
  readonly catalogPreparing?: boolean;
  readonly busy: boolean;
  readonly blockingBusy: boolean;
  readonly importBusy: boolean;
  readonly deletingDownloads?: boolean;
  readonly selectedBatchActive: boolean;
  readonly tasks: readonly ImportTaskView[];
  readonly linkedSeriesBookIds: ReadonlySet<string>;
  readonly sources: readonly ExternalSourceView[];
  readonly activeSourceId?: ExtensionContributionId;
  readonly items: readonly ExternalSourceItemView[];
  readonly query: string;
  readonly nextCursor?: string;
  readonly stale: boolean;
  readonly listError?: {
    readonly message: string;
    retry(): Promise<void>;
  };
  readonly detail?: ExternalSourceWorkDetail;
  readonly localSeriesNovel?: Novel;
  readonly localSeriesSourceId?: ExtensionContributionId;
  readonly browse?: ExternalSourceBrowseState;
  /** Last catalog navigation modes, retained while a work detail is open. */
  readonly catalogBrowse?: ExternalSourceBrowseState;
  readonly filterValues: Readonly<Record<string, ExternalSourceFilterValue>>;
  readonly breadcrumbs: readonly ExternalSourceBreadcrumb[];
  readonly currentFolderIsDefault: boolean;
  readonly currentLocationCanBeDefault: boolean;
  readonly canPickItems: boolean;
  readonly canRemoveItems: boolean;
  readonly progress?: ExternalSourceImportProgress;
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
  readonly libraryWorks: readonly ExternalSourceLibraryWork[];
  readonly libraryBootstrap?: { status: 'loading' | 'ready' | 'failed'; message?: string };
  retryLibrary?(): Promise<void>;
  batchLibraryTrash?(ids: readonly string[], action: 'trash' | 'restore'): Promise<readonly BatchLibraryItemResult[]>;
  restoreLibraryWork?(id: string): Promise<void>;
  purgeLibraryWork?(id: string): Promise<void>;
  emptyLibraryTrash?(): Promise<number>;
  /** Read releases against the source's full release list, per library book and per saved work. */
  readonly sourceWorkProgress?: SourceWorkProgressProjection;
  readonly activeSubscription?: ExternalSourceSubscriptionRecord;
  readonly checkingSubscriptions: boolean;
  readonly canSubscribeCurrentWork: boolean;
  canQueueItem(item: ExternalSourceItemView): boolean;
  isWorkInLibrary(item: ExternalSourceItemView): boolean;
  addWorkToLibrary(item: ExternalSourceItemView): Promise<void>;
  addCurrentWorkToLibrary(): Promise<void>;
  removeLibraryWork(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
  openDiscovery?(
    sourceId: ExtensionContributionId,
    input: ExternalSourceListInput,
    title?: string,
    item?: ExternalItemSummary,
  ): Promise<void>;
  show(sourceId?: ExtensionContributionId): void;
  showLocalSeries(novel: Novel): Promise<void>;
  resolveSourceSeriesBook?(novel: Novel): Promise<boolean | undefined>;
  readonly readingHistoryLoading?: boolean;
  continueSourceReading?(novel: Novel): Promise<boolean>;
  canResumeCurrentWork?: boolean;
  resumeCurrentWork?(): Promise<void>;
  close(): void;
  selectSource(id: ExtensionContributionId): Promise<void>;
  setQuery(value: string): void;
  search(): Promise<void>;
  setBrowseMode(mode: Exclude<ExternalSourceBrowseMode, 'search'>): Promise<void>;
  openCatalogBrowse(mode: Exclude<ExternalSourceBrowseMode, 'search'>): Promise<void>;
  setFilterValue(id: string, value: ExternalSourceFilterValue): void;
  applyFilters(): Promise<void>;
  resetFilters(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  toggleItem(key: string): void;
  selectAllSupported(selected: boolean, itemKeys?: readonly string[]): void;
  importItem(item: ExternalSourceItemView): Promise<void>;
  readonly streamingBookId?: string;
  readonly workReadingSessionId?: string;
  readonly readingHistoryRevision?: number;
  resetCurrentWorkHistory?(): Promise<void>;
  clearBookSourceHistory?(novel: Novel): Promise<void>;
  readonly streamCatalog?: SourceReaderCatalog;
  readonly streaming?: {
    item: ExternalSourceItemView;
    port: SourceReadingPort;
    historyKey?: string;
    fromStart?: boolean;
  };
  closeStream?(): void;
  openStreamItem?(item: ExternalSourceItemView): Promise<void>;
  saveTextStreamPosition?(
    item: ExternalSourceItemView,
    position: { paragraphIndex: number; offset: number; textHash: string; count: number },
  ): Promise<void>;
  saveStream?(item: ExternalSourceItemView): Promise<void>;
  saveStreamPosition?(item: ExternalSourceItemView, page: number, count: number, fraction?: number): Promise<void>;
  canStreamItem?(item: ExternalSourceItemView): boolean;
  readonly sourceVisits?: ReadonlyMap<string, SourceReleasePreference>;
  readonly sourceHistoryScope?: string;
  readonly currentWorkVisit?: SourceReleasePreference;
  readonly openingItemKey?: string;
  readonly libraryReader?: SourceLibraryReader;
  importAndOpen(item: ExternalSourceItemView): Promise<void>;
  importSelected(): Promise<void>;
  deleteDownloads(items: readonly ExternalSourceItemView[]): Promise<void>;
  openImported(item: ExternalSourceItemView, reportRejection?: boolean): Promise<void>;
  cancel(): void;
  dismissTask(taskId: string): void;
  connect(input?: ExternalSourceConnectionInput): Promise<void>;
  disconnect(): Promise<void>;
  openItem(item: ExternalSourceItemView): Promise<void>;
  openFolder(item: ExternalSourceItemView): Promise<void>;
  goBack(): Promise<void>;
  setCurrentFolderAsDefault(): Promise<void>;
  clearDefaultFolder(): Promise<void>;
  pickItems(): Promise<void>;
  removeItem(item: ExternalSourceItemView): Promise<void>;
  subscribeCurrentWork(): Promise<void>;
  unsubscribeCurrentWork(): Promise<void>;
  acknowledgeNewReleases(): Promise<void>;
  selectNewReleases(): void;
  checkSubscriptions(): Promise<void>;
  continueLibraryWork(workId: string): Promise<void>;
  openSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
  updateLibraryMetadata?(id: string, patch: SourceLibraryMetadataPatch): Promise<void>;
}

/** Session-only metadata snapshot. Never contains source bodies, credentials or download jobs. */
export interface ExternalSourceNavigationSnapshot {
  sourceId?: ExtensionContributionId;
  accountId?: string;
  generation?: string;
  items: readonly ExternalItemSummary[];
  query: string;
  nextCursor?: string;
  detail?: ExternalSourceWorkDetail;
  browse?: ExternalSourceBrowseState;
  filters: Readonly<Record<string, ExternalSourceFilterValue>>;
  breadcrumbs: readonly ExternalSourceBreadcrumb[];
  selected: ReadonlySet<string>;
  localBookId?: string;
  localSourceId?: ExtensionContributionId;
  defaultFolder?: ExternalSourceDefaultFolder;
  stale: boolean;
}

export interface UseExternalSourceControllerOptions {
  clearReadingHistory?(novelId: string): Promise<void>;
  saveTextPosition?: import('../../repositories/reader-repository').ReaderRepository['saveReadingPosition'];
  getReadingPosition?: import('../../repositories/reader-repository').ReaderRepository['getReadingPosition'];
  getParagraphPage?: import('../../repositories/reader-repository').ReaderRepository['getParagraphPage'];
  saveStreamPosition?(pageIndex: number, chapter: Chapter, novel: Novel, fraction?: number): Promise<void>;
  readonly downloadPolicy?: import('../../domain/types').DownloadPolicy;
  readonly updateDownloadPolicy?: (patch: Partial<import('../../domain/types').DownloadPolicy>) => void;
  readonly settingsScope?: string;
  readonly waitForReadingHistory?: () => Promise<void>;
  readonly readingActive?: boolean;
  readonly readingTarget?: { readonly novelId: string; readonly sectionId: string };
  readonly registry: ExternalSourceRegistryPort;
  readonly hostContext: TrustedExternalSourceHostContext;
  readonly state: ExternalSourceLocalState;
  readonly importService: ImportService;
  readonly assets?: BookAssetRepository;
  /** The backing reader persists exact fixed-document section read markers. */
  readonly extensionRevision: number;
  readonly libraryRevision?: number;
  listNovels(options?: { includeTrash?: boolean }): Promise<Novel[]>;
  listChapters(novelId: string): Promise<Chapter[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  openNovel(
    novel: Novel,
    target?: {
      readonly documentSectionId?: string;
      readonly documentSectionTitle?: string;
      readonly chapters?: Chapter[];
      readonly readerOptions?: import('../reader/reader-screen-contract').OpenReaderChapterOptions;
    },
  ): void | Promise<void>;
  prefetchChapter?(novel: Novel, chapter: Chapter): void;
  onLibraryChanged(): Promise<void>;
  onLibraryItemCommitted?(novel: Novel): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
  confirm(message: string): boolean;
}
