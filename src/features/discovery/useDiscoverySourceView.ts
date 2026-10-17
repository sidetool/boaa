/** useDiscoverySourceView({ section, source, session, refresh, controls = true, query = '' })
 * Returns root (scroll-to-top target), input/setRequest, draftQuery/setDraftQuery,
 * values/setValues/getFilterValue/setFilterValue, filtersOpen/setFiltersOpen, browse, definitions/fields/activeFilters/filterSummary/modes,
 * data (items, busy, error, hasPage, more, retry, loadMore), unavailable,
 * apply, changeMode(mode), resetSearch, resetFilters and itemOpenArgs(item).
 * Navigation state, pagination and filter-schema caching retain the classic screen lifecycle.
 */
import { useEffect, useId, useRef } from 'react';
import type {
  ExternalSourceBrowseState,
  ExternalItemSummary,
  ExternalSourceFilterChange,
  ExternalSourceFilterValue,
  ExternalSourceListInput,
} from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import type { DiscoverySession } from './discovery-session';
import type { DiscoverySection } from './discovery-config';
import { useDiscoveryPages } from './useDiscoveryPages';

export interface DiscoverySourceViewStateInput {
  section: DiscoverySection & { readonly query?: string };
  source?: ExternalSourceView;
  session: DiscoverySession;
  refresh: number;
  controls?: boolean;
  query?: string;
  /** Isolate temporary controls/page depth, keeping the app session's data cache and queues. */
  purpose?: 'browse' | 'row-builder';
}
export function useDiscoverySourceView({
  section,
  source,
  session,
  refresh,
  controls = true,
  query = '',
  purpose = 'browse',
}: DiscoverySourceViewStateInput) {
  const instance = useId();
  const root = useRef<HTMLDivElement>(null);
  const initialQuery = query || section.query || '';
  const initial: ExternalSourceListInput = {
    parentRef: section.parentRef,
    browseMode: (purpose !== 'row-builder' && initialQuery) || section.filters?.length ? 'search' : section.mode,
    query: purpose === 'row-builder' ? undefined : initialQuery || undefined,
    filters: section.filters,
  };
  const stateKey = `${purpose === 'row-builder' ? `row-builder:${instance}` : 'source-view'}:${section.id}:${session.key(section.sourceId, initial)}`;
  const [savedInput, setInput] = useNavigationViewState<ExternalSourceListInput>(stateKey, initial);
  const input = controls ? savedInput : initial;
  const [draftQuery, setDraftQuery] = useNavigationViewState(`${stateKey}:query`, input.query ?? '');
  const [values, setValues] = useNavigationViewState<Record<string, ExternalSourceFilterValue>>(
    `${stateKey}:filters`,
    {},
  );
  const [filtersOpen, setFiltersOpen] = useNavigationViewState(`${stateKey}:open`, false);
  const data = useDiscoveryPages(
    session,
    section.sourceId,
    input,
    refresh,
    source?.connection.state === 'connected',
    input.filters?.length ? section.filterSignature : undefined,
    stateKey,
  );
  const [browse, setBrowse] = useNavigationViewState<ExternalSourceBrowseState | undefined>(
    `${stateKey}:schema`,
    undefined,
  );
  useEffect(() => {
    if (data.browse) setBrowse(data.browse);
  }, [data.browse, setBrowse]);
  const definitions = (data.browse ?? browse)?.filters ?? [];
  const fields = definitions.filter((f) => f.kind !== 'header' && f.kind !== 'separator');
  const activeFilters =
    input.browseMode === 'search'
      ? fields.filter((f) => {
          const value = input.filters?.find(
            (v) => v.position === f.position && v.groupPosition === f.groupPosition,
          )?.value;
          return value !== undefined && JSON.stringify(value) !== JSON.stringify(f.defaultValue);
        })
      : [];
  const filterSummary = activeFilters
    .slice(0, 2)
    .map((f) => {
      const value = input.filters?.find((v) => v.position === f.position && v.groupPosition === f.groupPosition)?.value;
      if (f.kind === 'select' && typeof value === 'number') return `${f.label}: ${f.options[value]}`;
      if (f.kind === 'tri_state') return `${f.label} ${value === 'EXCLUDE' ? '제외' : '포함'}`;
      return f.label;
    })
    .join(' · ');
  const modes = (data.browse ?? browse)?.availableModes ?? ['popular', 'search'];
  const setRequest = (next: ExternalSourceListInput) => {
    setInput(next);
    root.current?.scrollIntoView({ block: 'start' });
  };
  const apply = () => {
    const filters: ExternalSourceFilterChange[] = fields.map((f) => ({
      position: f.position,
      groupPosition: f.groupPosition,
      value:
        values[f.id] ??
        input.filters?.find((v) => v.position === f.position && v.groupPosition === f.groupPosition)?.value ??
        f.defaultValue,
    }));
    setRequest({
      parentRef: section.parentRef,
      browseMode: 'search',
      query: purpose === 'row-builder' ? undefined : draftQuery.trim() || undefined,
      filters,
    });
  };
  const getFilterValue = (definition: (typeof definitions)[number]) =>
    values[definition.id] ??
    input.filters?.find(
      (value) => value.position === definition.position && value.groupPosition === definition.groupPosition,
    )?.value;
  const setFilterValue = (id: string, value: ExternalSourceFilterValue) => setValues({ ...values, [id]: value });
  const changeMode = (mode: ExternalSourceListInput['browseMode']) => {
    setDraftQuery('');
    setValues({});
    setRequest({ parentRef: section.parentRef, browseMode: mode });
  };
  const resetSearch = () => changeMode(section.mode);
  const resetFilters = () => setValues(Object.fromEntries(fields.map((f) => [f.id, f.defaultValue])));
  const itemOpenArgs = (item: ExternalItemSummary): [string, ExternalSourceListInput, string | undefined] => [
    section.sourceId,
    item.navigationRef ? { parentRef: item.navigationRef } : input,
    item.navigationRef ? item.title : undefined,
  ];
  return {
    root,
    input,
    setRequest,
    draftQuery,
    setDraftQuery,
    values,
    setValues,
    getFilterValue,
    setFilterValue,
    filtersOpen,
    setFiltersOpen,
    data,
    browse,
    definitions,
    fields,
    activeFilters,
    filterSummary,
    modes,
    apply,
    changeMode,
    resetSearch,
    resetFilters,
    itemOpenArgs,
    unavailable: !source || source.connection.state !== 'connected',
  };
}
