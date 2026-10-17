import { rememberDiscoverySourceDestination } from '../../features/discovery/source-view-navigation';
import { saveDiscoverySelection } from '../../features/discovery/use-discovery-selection';
import { useMemo, useSyncExternalStore } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { BookWorkspaceScreensProps } from '../../features/book-workspace/BookWorkspaceScreens';
import { rememberNavigationViewState } from '../../features/navigation/navigation-view-state';
import { setHomeActive } from './route';
import { HomeDiscoveryLoader, homeDiscoverySections, homeSourceSection, type HomeDiscoveryAdapter } from './discovery';
const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => 0;

/** Uses the app's discovery controller even when its screen has never mounted. No request on mount/render. */
export function useHomeDiscovery({
  discovery,
  externalSources,
  controller,
}: BookWorkspaceScreensProps): HomeDiscoveryAdapter | undefined {
  const session = discovery?.session;
  const loader = useMemo(() => (session ? new HomeDiscoveryLoader(session) : undefined), [session]);
  const revision = useSyncExternalStore(
    loader?.subscribe ?? subscribeEmpty,
    loader?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return useMemo(() => {
    if (!discovery || !loader) return undefined;
    const sections = homeDiscoverySections(discovery.config, externalSources.sources);
    const available = externalSources.sources.filter((source) => {
      const descriptor = session!.registry
        .getExternalSources()
        .find((entry) => entry.descriptor.id === source.id)?.descriptor;
      return (
        source.connection.state === 'connected' &&
        source.kind !== 'cloud_file' &&
        (!descriptor || descriptor.capabilities.includes('browse'))
      );
    });
    const activate = () => {
      setHomeActive(false);
      controller.setView('library');
      externalSources.close();
      discovery.setActive(true);
    };
    return {
      rowBuilder: {
        sources: available.map(({ id, title, kind }) => ({ id, title, kind })),
        session: discovery.session,
        sourceView: (id) => available.find((source) => source.id === id),
      },
      revision,
      sections,
      row: (config) => {
        const list =
          config.kind === 'source'
            ? homeSourceSection(config, externalSources.sources)
            : sections.find((section) => section.id === config.discoveryTabId);
        if (!list) throw new Error('home_source_row_unavailable');
        return loader.row(
          config,
          list,
          externalSources,
          (source, input, title) => {
            void externalSources.openDiscovery?.(source as ExtensionContributionId, input, title);
          },
          (tabId) => {
            saveDiscoverySelection(discovery.scope, { selected: tabId, quickSource: undefined });
            rememberNavigationViewState(`discovery-tab:${discovery.scope}`, tabId);
            rememberNavigationViewState(`discovery-quick:${discovery.scope}`, undefined);
            activate();
          },
          (section) => {
            rememberDiscoverySourceDestination(discovery.scope, section);
            activate();
          },
        );
      },
    };
  }, [discovery, loader, externalSources, controller, revision, session]);
}
