import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useAppRuntime } from '../runtime/RuntimeProvider';
import { useProductPlugins } from '../../extensions/platform/PlatformPluginProvider';
import { useReaderPluginPanelSelection } from '../../extensions/ui/ReaderPluginProvider';
import { ReaderPluginPanel } from '../../extensions/ui/ReaderPluginPanel';
import type { TrustedReaderAddonHostContext } from '../../extensions/reader-addon-host-context';

import { CORE_READER_ADDON_TABS } from '../../features/reader/reader-addon-contract';

import { UiNextReaderTools } from '../../ui-next/reader/UiNextReaderTools';
import type {
  ReaderAddonTab,
  ReaderScreenHandle,
  ReaderScreenModel,
} from '../../features/reader/reader-screen-contract';
import {
  usePluginAnnotationRefresh,
  type PluginAnnotationRefreshPorts,
} from '../../features/reader/use-plugin-annotation-refresh';

const ReaderScreen = lazy(() => import('../../features/reader/ReaderScreen'));
interface ReaderFeatureHostProps extends PluginAnnotationRefreshPorts {
  readonly model: ReaderScreenModel;
  readonly screenHandle: ReaderScreenHandle;
  readonly addonOpen: boolean;
  readonly addonTab: ReaderAddonTab;
  readonly setAddonTab: (tab: ReaderAddonTab) => void;
  readonly closeAddon: () => void;
  readonly theme: 'dark' | 'light';
  readonly trustedContext?: TrustedReaderAddonHostContext;
  readonly children: ReactNode;
}

/** Plugin snapshots subscribe at the Reader subtree, independently of App's AI/TTS orchestration. */
export function ReaderFeatureHost(props: ReaderFeatureHostProps) {
  const ToolsShell = UiNextReaderTools;
  const { extensionRuntime } = useAppRuntime();
  const productPlugins = useProductPlugins();
  const { host, snapshot } = useReaderPluginPanelSelection(props.addonOpen ? props.addonTab : null);
  useLayoutEffect(
    () => () => {
      host?.selectPanel(null);
    },
    [host],
  );
  const revision = useSyncExternalStore(
    extensionRuntime.manager.subscribe,
    extensionRuntime.manager.getRevision,
    extensionRuntime.manager.getRevision,
  );
  const tabs = useMemo(() => {
    void revision;
    return [
      ...CORE_READER_ADDON_TABS,
      ...extensionRuntime.trustedExtensions.getReaderAddonTabs().map(({ descriptor }) => descriptor),
      ...snapshot.entries
        .filter((entry) => !extensionRuntime.trustedExtensions.getReaderAddon(entry.tab.id))
        .map((entry) => entry.tab),
    ].sort((left, right) => (left.order ?? 500) - (right.order ?? 500) || left.id.localeCompare(right.id));
  }, [extensionRuntime, revision, snapshot.entries]);
  const { addonOpen, addonTab, setAddonTab } = props;
  useEffect(() => {
    if (addonOpen && !tabs.some((tab) => tab.id === addonTab)) setAddonTab('outline');
  }, [addonOpen, addonTab, tabs, setAddonTab]);
  const trusted = extensionRuntime.trustedExtensions.getReaderAddon(addonTab);
  const plugin = !trusted ? snapshot.entries.find((entry) => entry.tab.id === addonTab) : undefined;
  const refreshAnnotations = usePluginAnnotationRefresh(
    props.model.novel.id,
    props.model.novel.activeContentRevisionId,
    props,
  );
  return (
    <>
      <Suspense fallback={<main className="reader-screen reader-loading" aria-busy="true" />}>
        <ReaderScreen
          model={props.model}
          screenHandle={props.screenHandle}
          platformPlugins={productPlugins.session?.service}
          onPluginAnnotationsChanged={refreshAnnotations}
        />
      </Suspense>
      {addonOpen && (
        <ToolsShell activeTab={addonTab} tabs={tabs} setActiveTab={setAddonTab} close={props.closeAddon}>
          {plugin && <ReaderPluginPanel entry={plugin} theme={props.theme} close={props.closeAddon} />}
          {trusted && props.trustedContext && (
            <Suspense fallback={null}>{trusted.render(props.trustedContext)}</Suspense>
          )}
          {props.children}
        </ToolsShell>
      )}
    </>
  );
}
