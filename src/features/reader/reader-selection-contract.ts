import { type ReactNode } from 'react';
import type { ReaderLocationSnapshot, ReaderScreenHandle, ReaderSelection } from './reader-screen-contract';

export interface ReaderSelectionToolbarProps {
  readonly selection: ReaderSelection;
  readonly location?: ReaderLocationSnapshot;
  readonly screenHandle: ReaderScreenHandle;
  readonly onClear: () => void;
  readonly pluginAction?: ReactNode;
}
