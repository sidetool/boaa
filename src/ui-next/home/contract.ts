import type { ExternalSourceFilterChange } from '../../external-sources/contracts';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import type { ExternalSourceView } from '../../features/external-sources/external-source-controller-contract';
import type { HomeSourcePosition } from './source-continuity';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import type { UiNextLibraryAdapter, LibraryProgress } from '../library/contract';

/** Rows the reader can place on the home screen. The hero always shows recently read works. */
export type HomeRowKind =
  'recently-added' | 'unread' | 'finished' | 'favorites' | 'shelf' | 'external-updates' | 'discovery' | 'source';

export interface HomeSourceRowSection {
  sourceId: string;
  mode: 'popular' | 'latest';
  filters?: ExternalSourceFilterChange[];
  filterSignature?: string;
  parentRef?: string;
  title: string;
  summary?: string;
}

/** Persisted (and synced) home layout. Order is display order; hidden rows stay so the editor can restore them. */
export interface HomeRowConfig {
  id: string;
  kind: HomeRowKind;
  visible: boolean;
  shelfId?: string;
  /** Discovery tab or list the row mirrors when `kind` is `discovery`. */
  discoveryTabId?: string;
  /** Required for source rows; independent of discovery tabs. */
  section?: HomeSourceRowSection;
}

export interface HomeHeroItem {
  /** Source episode number for the continue action; never a saved-chapter index. */
  episodeNumber?: number;
  /** Raw source episode position; presentation belongs to the home UI. */
  sourcePosition?: HomeSourcePosition;
  /** `continue` for recently read works; `new` fills the hero with recent additions when nothing has been read. */
  reason: 'continue' | 'new';
  item: LibraryWorkItem;
  progress: LibraryProgress;
  /** Where reading stops, e.g. `12화 · 장 제목` or `38쪽`. */
  positionLabel: string;
  /** Relative time of the last visit, e.g. `어제`. */
  lastReadLabel: string;
  /** Primary button text, e.g. `12화 이어 읽기`. */
  resumeLabel: string;
  /** Format, source, genres. Short labels only. */
  tags: readonly string[];
  synopsis?: string;
  resume(): void | Promise<unknown>;
  openDetail(): void | Promise<unknown>;
}

/** Source works shown on home that are not in the library yet. */
export interface HomeDiscoveryItem {
  id: string;
  title: string;
  author?: string;
  thumbnailUrl?: string;
  /** Authenticated artwork; the UI calls it only while the card is near the viewport. */
  loadCover?(signal: AbortSignal): Promise<string | undefined>;
  /** Already saved in the library. */
  owned?: boolean;
  /** Short badge such as a rank, `NEW` or a release count. */
  badge?: string;
  subline?: string;
  open(): void | Promise<unknown>;
}

export type HomeRowItem =
  { kind: 'library'; key: string; item: LibraryWorkItem } | { kind: 'discovery'; key: string; work: HomeDiscoveryItem };

export interface HomeRowView {
  config: HomeRowConfig;
  title: string;
  /** Small label above the title, e.g. the source name of a discovery row. */
  eyebrow?: string;
  /** Ranked rows render with large numerals. */
  ranked?: boolean;
  status: 'loading' | 'ready' | 'failed';
  items: readonly HomeRowItem[];
  /** Opens the full list (a library filter or shelf, or the discovery tab). */
  openAll?(): void;
  /**
   * Call when near the viewport, including rows already `ready` from memory cache, to refresh as needed.
   * Idempotent. Uncached rows start `loading`; failed refreshes retain previously published items.
   */
  requestLoad?(): void;
  /** Shown with failed rows. */
  retry?(): void;
  /** Failure detail; cached rows remain `ready` when only their background refresh fails. */
  error?: string;
}

/** Choices offered by the home editor's "줄 추가" sheet; rows already present are excluded. */
export interface HomeRowOption {
  kind: HomeRowKind;
  label: string;
  hint: string;
  shelfId?: string;
  discoveryTabId?: string;
}

export interface UiNextHomeAdapter {
  rowBuilder?: {
    sources: readonly { id: string; title: string; kind?: string }[];
    session: DiscoverySession;
    sourceView(id: string): ExternalSourceView | undefined;
  };
  status: 'loading' | 'ready' | 'failed';
  /** Recently read unfinished works, newest first, at most 5. Falls back to up to 3 recent unread additions. */
  hero: readonly HomeHeroItem[];
  /** Visible rows in display order. Empty rows are still included; the UI decides how to show them. */
  rows: readonly HomeRowView[];
  /** Full persisted layout including hidden rows, for the editor. */
  config: readonly HomeRowConfig[];
  rowOptions: readonly HomeRowOption[];
  /** Label shown for a config row in the editor. */
  rowLabel(config: HomeRowConfig): string;
  setConfig(next: readonly HomeRowConfig[]): void;
  resetConfig(): void;
  /** Library helpers reused by row tiles (progress, menus, import state, activation). */
  library: Pick<
    UiNextLibraryAdapter,
    'bookProgress' | 'externalProgress' | 'bookMenu' | 'externalMenu' | 'taskForBook' | 'taskForExternal' | 'activate'
  >;
  /** Empty-home actions. */
  importFiles(): void;
  addSamples?(): void;
  openDiscovery?(): void;
}

export interface UiNextHomeScreenProps {
  adapter: UiNextHomeAdapter;
  navigation: import('../shell/contract').UiNextNavigation;
  libraryProps: import('../../features/library/library-screen-contract').LibraryScreenProps;
}
