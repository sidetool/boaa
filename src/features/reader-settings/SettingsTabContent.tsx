import { StartupScreenSettings } from './StartupScreenSettings';
import { PlatformPluginSettings } from '../../extensions/platform/PlatformPluginSettings';
import { WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID } from '../../extensions/builtin/webnovel-metadata-enrichment-extension';
import { ExtensionSettingsPanel } from '../extensions/ExtensionSettingsPanel';
import { WebNovelMetadataExtensionSettings } from '../extensions/WebNovelMetadataExtensionSettings';
import { ExternalSourceSettingsPanel } from '../external-sources/ExternalSourceSettingsPanel';
import { ApplicationInfoSettings } from './ApplicationInfoSettings';
import { SourceAdvancedSettings } from './SourceAdvancedSettings';
import { ReaderGestureSettings } from './ReaderGestureSettings';
import { ReaderSettingsAppearance } from './ReaderSettingsAppearance';
import { ReaderSettingsLayout } from './ReaderSettingsLayout';
import { RemoteAccessSettings } from './RemoteAccessSettings';
import { SyncSettings } from './SyncSettings';

import type { ReactNode } from 'react';
import { StorageSettingsPanel } from './StorageSettingsPanel';
import type { ReaderSettingsPanelProps, SettingsTab } from './settings-panel-contract';

export type SettingsTabContentProps = ReaderSettingsPanelProps & {
  tab: SettingsTab;
  onStorageBusyChange(busy: boolean): void;
  openDestination(destination: () => void): void;
  /** Replaces the link to download settings in 콘텐츠 소스 and the download fold in 저장공간. */
  sourceReadingSettings: ReactNode;
};

/** Shared tab bodies; the surrounding panel owns navigation, focus and storage close guards. */
export function SettingsTabContent(props: SettingsTabContentProps) {
  const { controller, profile, tab, onStorageBusyChange, openDestination } = props;
  return (
    <>
      {tab === 'appearance' && (
        <>
          <StartupScreenSettings controller={controller} shelves={props.startupShelves} tabs={props.startupTabs} />
        </>
      )}
      {tab === 'layout' && (
        <>
          <ReaderSettingsAppearance
            controller={controller}
            profile={profile}
            updateProfile={props.updateProfile}
            personalizationRepository={props.personalizationRepository}
            themeTarget="reader"
          />
          <ReaderSettingsLayout controller={controller} profile={profile} updateProfile={props.updateProfile} />
        </>
      )}
      {tab === 'gesture' && (
        <ReaderGestureSettings bindings={props.gestureBindings} update={props.updateGestureBindings} />
      )}
      {tab === 'extensions' && (
        <>
          <PlatformPluginSettings />
          <ExtensionSettingsPanel
            extensions={props.extensions}
            setEnabled={props.setExtensionEnabled}
            renderDetails={(extension) =>
              props.renderExtensionDetails?.(extension) ??
              (extension.id === WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID &&
              props.webNovelMetadataCollector &&
              props.bookEnrichmentAutomation ? (
                <WebNovelMetadataExtensionSettings
                  broker={props.webNovelMetadataCollector}
                  automation={props.bookEnrichmentAutomation}
                  extensionEnabled={extension.enabled}
                  libraryCount={props.libraryCount ?? 0}
                  confirm={(message) => window.confirm(message)}
                />
              ) : undefined)
            }
          />
        </>
      )}
      {tab === 'sources' && (
        <div className="reader-settings-source-sections">
          {props.installedPackages}
          <ExternalSourceSettingsPanel
            controller={props.externalSources}
            onBrowse={(id) => openDestination(() => props.externalSources.show(id))}
          />
          {props.sourceReadingSettings}
          <SourceAdvancedSettings controller={controller} />
        </div>
      )}
      {tab === 'storage' && (
        <StorageSettingsPanel
          {...props.storage}
          controller={props.externalSources}
          openBackup={() => openDestination(props.openBackup)}
          onBusyChange={onStorageBusyChange}
        />
      )}
      {tab === 'sync' && (
        <SyncSettings openSync={() => openDestination(props.openSync)}>{props.syncContent}</SyncSettings>
      )}
      {tab === 'remote-access' && <RemoteAccessSettings serverApiBaseUrl={props.serverApiBaseUrl} />}
      {tab === 'application' && (
        <ApplicationInfoSettings
          platformRuntime={props.platformRuntime}
          providerExecutionRuntime={props.providerExecutionRuntime}
          selfHostAccount={props.selfHostAccount}
          logoutSelfHostAccount={props.logoutSelfHostAccount}
        />
      )}
    </>
  );
}
