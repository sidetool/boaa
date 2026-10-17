/** Portable filter values; structurally identical to ExternalSourceFilterChange. */
export interface ReaderHomeSourceSection {
  sourceId: string;
  mode: 'popular' | 'latest';
  filters?: {
    readonly position: number;
    readonly groupPosition?: number;
    readonly value: boolean | number | string | { readonly index: number; readonly ascending: boolean };
  }[];
  filterSignature?: string;
  parentRef?: string;
  title: string;
  summary?: string;
}

/** Shared wire shape; kept independent of the web presentation layer. */
export interface ReaderHomeRowConfig {
  id: string;
  kind: 'recently-added' | 'unread' | 'finished' | 'favorites' | 'shelf' | 'external-updates' | 'discovery' | 'source';
  visible: boolean;
  shelfId?: string;
  discoveryTabId?: string;
  section?: ReaderHomeSourceSection;
}
