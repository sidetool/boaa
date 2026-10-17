import type { Bookmark, ReaderHighlight } from '../../domain/types';
import type { ReaderChromeController } from './use-reader-chrome';
import type { ReaderSearchController } from './use-reader-search';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  ReaderScreenHandle,
  ReaderScreenModel,
  ReaderSelection,
} from './reader-screen-contract';
import type { ReaderRuntimeFlow, ReaderViewportApi } from './ReaderViewport';

export interface ReaderChromeProps {
  readonly model: ReaderScreenModel;
  readonly screenHandle: ReaderScreenHandle;
  readonly viewport?: ReaderViewportApi;
  readonly chrome: ReaderChromeController;
  readonly search: ReaderSearchController;
  readonly location?: ReaderLocationSnapshot;
  readonly mode: ReaderMode;
  readonly readingFlow: ReaderRuntimeFlow;
  readonly activeBookmark?: Bookmark;
  readonly activeHighlight?: ReaderHighlight;
  readonly selection?: ReaderSelection;
  readonly mobileSearchOpen: boolean;
  readonly overflowOpen: boolean;
  readonly onSetMode: (mode: ReaderMode) => void;
  readonly onMobileSearchOpenChanged: (open: boolean) => void;
  readonly onOverflowOpenChanged: (open: boolean) => void;
  readonly onGoToSavedPosition: () => void;
  readonly onOpenAutoScroll?: () => void;
}
