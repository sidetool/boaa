import type { LibraryWorkItem } from '../../features/library/library-work-order';
import type { HomeDiscoveryItem, UiNextHomeAdapter } from '../home/contract';

/** One source's answer to the submitted query. Sources answer independently; a slow one never holds the rest. */
export interface UiNextSearchSourceGroup {
  sourceId: string;
  title: string;
  /** `idle` before the first submit. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** First page only; the row shows a few and `openAll` continues in the source's own search. */
  items: readonly HomeDiscoveryItem[];
  error?: string;
  retry(): void;
  /** Opens this source's search with the same query in 탐색. */
  openAll?(): void;
}

/** ui-next 통합 검색: the library filters as the reader types; sources are asked only on submit. */
export interface UiNextSearchAdapter {
  /** Library works matching `query` (title, author, tags), best match first. Synchronous and local. */
  library(query: string): readonly LibraryWorkItem[];
  /** Tiles reuse the library helpers for progress, menus, import state and activation. */
  libraryHelpers: UiNextHomeAdapter['library'];
  /** Last submitted query; source groups belong to it. Empty until the first submit. */
  submitted: string;
  /** Searchable sources in the reader's source order. Empty when no source is installed. */
  sources: readonly UiNextSearchSourceGroup[];
  /** Trims, records in recent searches and asks every source in parallel. Aborts the previous query. */
  submit(query: string): void;
  /** Aborts in-flight source requests (closing the screen calls this). */
  cancel(): void;
  /** Newest first, at most 8, synced like other preferences when available. */
  recent: readonly string[];
  removeRecent(query: string): void;
  clearRecent(): void;
}

export interface UiNextSearchScreenProps {
  adapter: UiNextSearchAdapter;
  /** Query to start with, e.g. from a tag tap. */
  initialQuery?: string;
  close(): void;
}
