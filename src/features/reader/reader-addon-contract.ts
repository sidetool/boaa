import type { ReaderAddonIconName } from '@boaa/extension-contracts';
import { type ReactNode } from 'react';
import type { ReaderAddonTab } from './reader-screen-contract';

export interface ReaderAddonTabDescriptor {
  readonly id: ReaderAddonTab;
  readonly label: string;
  readonly icon: ReaderAddonIconName;
  readonly order?: number;
}

export const CORE_READER_ADDON_TABS: readonly ReaderAddonTabDescriptor[] = [
  { id: 'outline', label: '목차', icon: 'list', order: 20 },
  { id: 'tts', label: '듣기', icon: 'headphones', order: 30 },
  { id: 'notes', label: '주석', icon: 'notes', order: 40 },
  { id: 'stats', label: '통계', icon: 'chart', order: 50 },
];

export interface ReaderAddonShellProps {
  readonly activeTab: ReaderAddonTab;
  readonly tabs: readonly ReaderAddonTabDescriptor[];
  readonly children: ReactNode;
  setActiveTab(tab: ReaderAddonTab): void;
  close(): void;
}
