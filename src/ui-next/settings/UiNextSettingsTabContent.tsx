import { TranslationPage } from './pages/TranslationPage';
import { SettingsTabContent, type SettingsTabContentProps } from '../../features/reader-settings/SettingsTabContent';
import { WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID } from '../../extensions/builtin/webnovel-metadata-enrichment-extension';
import { AccountPage } from './pages/AccountPage';
import { AppInfoPage } from './pages/AppInfoPage';
import { ExtensionsPage } from './pages/ExtensionsPage';
import { GesturePage } from './pages/GesturePage';
import { ReaderLookPage } from './pages/ReaderLookPage';
import { RemoteAccessPage } from './pages/RemoteAccessPage';
import { ServerManagementPage } from './pages/ServerPage';
import { SourcesPage } from './pages/SourcesPage';
import { StartupPage } from './pages/StartupPage';
import { StoragePage } from './pages/StoragePage';
import { WebNovelInfoSettings } from './pages/WebNovelInfoSettings';
import './pages/pages.css';

/** Settings pages rebuilt for ui-next; tabs not moved yet still render the shared bodies. */
export function UiNextSettingsTabContent(props: SettingsTabContentProps) {
  switch (props.tab) {
    case 'account':
      return <AccountPage />;
    case 'appearance':
      return <StartupPage controller={props.controller} shelves={props.startupShelves} tabs={props.startupTabs} />;
    case 'layout':
      return (
        <ReaderLookPage
          controller={props.controller}
          profile={props.profile}
          updateProfile={props.updateProfile}
          personalizationRepository={props.personalizationRepository}
        />
      );
    case 'gesture':
      return <GesturePage bindings={props.gestureBindings} update={props.updateGestureBindings} />;
    case 'extensions':
      return (
        <ExtensionsPage
          extensions={props.extensions}
          setEnabled={props.setExtensionEnabled}
          renderDetails={(extension) =>
            props.renderExtensionDetails?.(extension) ??
            (extension.id === WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID &&
            props.webNovelMetadataCollector &&
            props.bookEnrichmentAutomation ? (
              <WebNovelInfoSettings
                broker={props.webNovelMetadataCollector}
                automation={props.bookEnrichmentAutomation}
                extensionEnabled={extension.enabled}
                libraryCount={props.libraryCount ?? 0}
              />
            ) : undefined)
          }
        />
      );
    case 'sources':
      return (
        <SourcesPage
          installedPackages={props.installedPackages}
          sourceReadingSettings={props.sourceReadingSettings}
          externalSources={props.externalSources}
          settingsController={props.controller}
          onBrowse={(id) => props.openDestination(() => props.externalSources.show(id))}
        />
      );
    case 'storage':
      return (
        <StoragePage
          {...props.storage}
          controller={props.externalSources}
          openBackup={() => props.openDestination(props.openBackup)}
          onBusyChange={props.onStorageBusyChange}
        />
      );
    case 'remote-access':
      return <RemoteAccessPage serverApiBaseUrl={props.serverApiBaseUrl} />;
    case 'translation':
      return <TranslationPage />;
    case 'server':
      return <ServerManagementPage />;
    case 'application':
      return (
        <AppInfoPage
          platformRuntime={props.platformRuntime}
          providerExecutionRuntime={props.providerExecutionRuntime}
        />
      );
    default:
      return <SettingsTabContent {...props} />;
  }
}
