import type { LibraryScreenProps, LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryBookView, LibraryFilter } from '../../features/library/library-screen-model';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import type { ImportTaskView } from '../../features/import/import-task-projection';
import type { UiNextNavigation } from '../shell/contract';

/** UI must honor disabled; run also guards against invoking a disabled command. */
export interface LibraryAction {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  run(): void | Promise<unknown>;
}
export interface LibraryProgress {
  episodeNumber?: number;
  current?: number;
  total?: number;
  progress: number;
  percent: number;
  subline: string;
}
export interface LibraryBatchInput {
  shelfId?: string;
  tag?: string;
}
export interface UiNextLibraryAdapter {
  /** Already filtered by the controller, with local and external works sorted together. */
  works: readonly LibraryWorkItem[];
  standaloneImportTasks: readonly ImportTaskView[];
  filterCounts: Readonly<Record<LibraryFilter, number>>;
  bookProgress(book: LibraryBookView): LibraryProgress;
  externalProgress(work: LibraryExternalWorkView): LibraryProgress;
  bookMenu(book: LibraryBookView): readonly LibraryAction[];
  externalMenu(work: LibraryExternalWorkView): readonly LibraryAction[];
  batchActions(input?: LibraryBatchInput): readonly LibraryAction[];
  importActions(task: ImportTaskView): readonly LibraryAction[];
  importMenu: readonly LibraryAction[];
  sortActions: readonly LibraryAction[];
  managementActions: readonly LibraryAction[];
  taskForBook(id: string): ImportTaskView | undefined;
  taskForExternal(id: string): ImportTaskView | undefined;
  isSelected(item: LibraryWorkItem): boolean;
  /** Preserves selection/import/trash guards before calling the existing book actions. */
  activate(item: LibraryWorkItem): void | Promise<unknown>;
  /** Long press / hover check: enter selection mode with this work already picked. Undefined when selection is unavailable. */
  pick?(item: LibraryWorkItem): void;
}
export interface UiNextLibraryScreenProps extends LibraryScreenProps {
  navigation: UiNextNavigation;
  adapter: UiNextLibraryAdapter;
}
