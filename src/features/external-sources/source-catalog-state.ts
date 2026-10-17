import type {
  ExternalItemSummary,
  ExternalSourceBrowseState,
  ExternalSourceFilterValue,
  ExternalSourceListInput,
  ExternalSourceWorkDetail,
} from '../../external-sources/contracts';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { Dispatch, SetStateAction } from 'react';
export interface SourceCatalogState {
  loading: boolean;
  catalogLoading: boolean;
  catalogItems: readonly ExternalItemSummary[];
  nextCursor?: string;
  stale: boolean;
  listFailure?: { message: string; input: ExternalSourceListInput; append: boolean; sourceId: ExtensionContributionId };
  catalogDetail?: ExternalSourceWorkDetail;
  browse?: ExternalSourceBrowseState;
  catalogBrowse?: ExternalSourceBrowseState;
  catalogBrowseParentRef?: string;
  filterValues: Readonly<Record<string, ExternalSourceFilterValue>>;
}
export const initialSourceCatalogState: SourceCatalogState = {
  loading: false,
  catalogLoading: false,
  catalogItems: [],
  stale: false,
  filterValues: {},
};
export function sourceCatalogSetters(update: Dispatch<SetStateAction<SourceCatalogState>>) {
  const setter =
    <K extends keyof SourceCatalogState>(key: K) =>
    (value: SetStateAction<SourceCatalogState[K]>) =>
      update((previous) => ({ ...previous, [key]: typeof value === 'function' ? value(previous[key]) : value }));
  return {
    setLoading: setter('loading'),
    setCatalogLoading: setter('catalogLoading'),
    setRawItems: setter('catalogItems'),
    setNextCursor: setter('nextCursor'),
    setStale: setter('stale'),
    setListFailure: setter('listFailure'),
    setDetail: setter('catalogDetail'),
    setBrowse: setter('browse'),
    setCatalogBrowse: setter('catalogBrowse'),
    setCatalogBrowseParentRef: setter('catalogBrowseParentRef'),
    setFilterValues: setter('filterValues'),
  };
}
