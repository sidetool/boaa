import type { ReactNode } from 'react';

export interface UiNextNavigation {
  /** Source browsing belongs to discovery; chapters retain their originating home/library tab. */
  activeTab: 'home' | 'discovery' | 'library';
  openHome(): void;
  isReader: boolean;
  /** A source stream owns the viewport while the workspace remains on its source detail. */
  readerOverlay?: boolean;
  openDiscovery?: () => void;
  openLibraryRoot(): void;
  openSettings(): void;
  /** Opens unified search; the current workspace destination remains its back target. */
  openSearch?(initialQuery?: string): void;
  /** Opens the library root and increments searchFocusRequest, including across route mounts. */
  focusSearch(): void;
  /** UI opens its inline search and focuses it when this monotonically increasing value changes. */
  searchFocusRequest: number;
}
export interface UiNextShellProps extends UiNextNavigation {
  children: ReactNode;
}
