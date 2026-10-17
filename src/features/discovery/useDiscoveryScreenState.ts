import { discoverySourceDestinationKey, type DiscoverySourceDestination } from './source-view-navigation';
/** useDiscoveryScreenState({ library, discovery, sources, open }) owns discovery screen state/commands.
 * Returns config/scope/session, tabs/selected/setSelected/tab/selectTab, quickSource/setQuickSource,
 * viewMode/setViewMode, draftQuery/setDraftQuery/query/setQuery/submitSearch/resetSearch,
 * searchSource/setSearchSource, rows/dedicated/sectionSources, positions and scroll (body restoration ref),
 * openQuick/owned, refresh/setRefresh/refreshSections, editing/setEditing, quickJump/setQuickJump,
 * pinError/togglePin/pinned. Tab-strip scrolling remains a UI responsibility.
 * library is retained in the input contract for interchangeable classic/ui-next screen props.
 */
import { useDiscoverySelection } from './use-discovery-selection';
import { useRef, useState } from 'react';
import { useWorkView } from '../../components/work-view';
import { useDiscoveryScroll } from './useDiscoveryScroll';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import type { ExternalSourceController, ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { ExternalSourceListInput, ExternalItemSummary } from '../../external-sources/contracts';
import type { DiscoveryController } from './useDiscoveryController';
import { pinnedSource, togglePinnedSource } from './discovery-config';
export interface DiscoveryScreenProps {
  library: LibraryScreenProps;
  discovery: DiscoveryController;
  sources: ExternalSourceController;
  open(source: string, input: ExternalSourceListInput, title?: string): void;
}
export function useDiscoveryScreenState({ discovery, sources, open }: DiscoveryScreenProps) {
  const { config, scope, session } = discovery;
  const tabs = config.tabs.filter((t) => !t.hidden);
  const { selected, setSelected, quickSource, setQuickSource } = useDiscoverySelection(
    scope,
    tabs[0]?.id ?? '',
    sources.sources.map((source) => source.id),
  );
  const [quickSection, setQuickSection] = useNavigationViewState<DiscoverySourceDestination | undefined>(
    discoverySourceDestinationKey(scope),
    undefined,
  );
  const tab = tabs.find((t) => t.id === selected) ?? tabs[0];
  const [viewMode, setViewMode] = useWorkView(
    `boaa.discovery-view:${quickSource ?? tab?.id ?? 'home'}`,
    tab?.density === 'compact' ? 'compact' : 'grid',
  );
  const [pinError, setPinError] = useState('');
  const [editing, setEditing] = useState(false);
  const [quickJump, setQuickJump] = useState(false);
  const [draftQuery, setDraftQuery] = useNavigationViewState(`discovery-draft:${scope}:${tab?.id}`, '');
  const [query, setQuery] = useNavigationViewState(`discovery-query:${scope}:${tab?.id}`, '');
  const [searchSource, setSearchSource] = useNavigationViewState(`discovery-search-source:${scope}:${tab?.id}`, 'all');
  const [refresh, setRefresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = session.railPositions;
  useDiscoveryScroll(
    scroll,
    `discovery:${scope}:${quickSource ? (quickSection?.id ?? quickSource) : tab?.id}:${query}:${searchSource}`,
    session,
  );
  const dedicated = quickSource
    ? quickSection?.sourceId === quickSource
      ? quickSection
      : { id: `quick:${quickSource}`, sourceId: quickSource, title: '', mode: 'popular' as const }
    : tab?.sections.length === 1 && sources.sources.find((s) => s.id === tab.sections[0]?.sourceId)?.kind === 'catalog'
      ? tab.sections[0]
      : undefined;
  const openQuick = async (sourceId: string, input: ExternalSourceListInput) => {
    if (sources.sources.find((s) => s.id === sourceId)?.kind !== 'catalog') {
      open(sourceId, input);
      return;
    }
    setQuickSection(undefined);
    const pinned = config.tabs.find((t) => pinnedSource(t) === sourceId);
    if (pinned) {
      if (pinned.hidden) {
        try {
          await discovery.save(
            {
              ...config,
              tabs: config.tabs.map((t) => (t.id === pinned.id ? { ...t, hidden: false } : t)),
            },
            config,
          );
        } catch {
          setPinError('탭을 저장하지 못했습니다. 다시 시도해 주세요.');
          return false;
        }
      }
      setSelected(pinned.id);
      setQuickSource(undefined);
    } else setQuickSource(sourceId);
  };
  const owned = (item: ExternalItemSummary) =>
    sources.libraryWorks.some(
      (work) =>
        work.connectorId === item.key.connectorId &&
        work.accountConnectionId === item.key.accountConnectionId &&
        work.collectionRemoteId === item.key.remoteId,
    );
  const sectionSources = [...new Set(tab?.sections.map((s) => s.sourceId) ?? [])];
  const rows = query
    ? sectionSources
        .filter((id) => searchSource === 'all' || id === searchSource)
        .map((id) => ({ id: `search:${id}`, sourceId: id, title: '', mode: 'popular' as const }))
    : (tab?.sections ?? []);
  const togglePin = async (source: Pick<ExternalSourceView, 'id' | 'title'>) => {
    try {
      const next = togglePinnedSource(config, source.id, source.title);
      await discovery.save(next, config);
      setPinError('');
      const pinned = next.tabs.find((t) => pinnedSource(t) === source.id);
      if (pinned) {
        setSelected(pinned.id);
        setQuickSource(undefined);
      } else if (config.tabs.some((t) => t.id === selected && pinnedSource(t) === source.id)) setQuickSource(source.id);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : '탭을 저장하지 못했습니다.');
    }
  };
  const selectTab = (id: string) => {
    setSelected(id);
    setQuickSource(undefined);
  };
  const submitSearch = () => setQuery(draftQuery.trim());
  const resetSearch = () => {
    setQuery('');
    setDraftQuery('');
  };
  const refreshSections = () => setRefresh((value) => value + 1);
  const pinned = config.tabs.flatMap((t) => (pinnedSource(t) ? [pinnedSource(t)!] : []));
  return {
    config,
    scope,
    session,
    tabs,
    selected,
    setSelected,
    tab,
    quickSource,
    setQuickSource,
    viewMode,
    setViewMode,
    pinError,
    editing,
    setEditing,
    quickJump,
    setQuickJump,
    draftQuery,
    setDraftQuery,
    query: quickSource && quickSection?.sourceId === quickSource ? (quickSection.query ?? '') : query,
    setQuery,
    searchSource,
    setSearchSource,
    refresh,
    setRefresh,
    scroll,
    positions,
    dedicated,
    openQuick,
    owned,
    sectionSources,
    rows,
    togglePin,
    selectTab,
    submitSearch,
    resetSearch,
    refreshSections,
    pinned,
  };
}
