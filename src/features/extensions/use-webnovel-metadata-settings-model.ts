import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS,
  type WebNovelMetadataCollectorAuthPlatform,
} from '../../services/webnovel-metadata-collector-client';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import type { BookEnrichmentAutomationController } from '../book-enrichment/useBookEnrichmentAutomation';

function isRemoteEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export function useWebNovelMetadataSettingsModel(
  broker: WebNovelMetadataCollectorBroker,
  automation: BookEnrichmentAutomationController,
) {
  const snapshot = useSyncExternalStore(broker.subscribe, broker.getSnapshot, broker.getSnapshot);
  const [endpoint, setEndpoint] = useState(snapshot.settings.endpoint);
  const [operation, setOperation] = useState<string>();
  const [error, setError] = useState<{ cause: unknown }>();
  const [remotePlatform, setRemotePlatform] = useState<WebNovelMetadataCollectorAuthPlatform>();
  const [remoteBrowserVisible, setRemoteBrowserVisible] = useState(false);
  const connected = snapshot.connectionState === 'connected';
  const managed = broker.connectionMode === 'managed';
  const remoteAuthBrowser = snapshot.health?.capabilities.adultAuth.browserPresentation === 'remote_frame';
  const directLoginPlatforms = snapshot.health?.capabilities.adultAuth.directLoginPlatforms ?? [];
  const authPlatforms = snapshot.health?.capabilities.adultAuth.platforms ?? WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS;

  useEffect(() => setEndpoint(snapshot.settings.endpoint), [snapshot.settings.endpoint]);
  useEffect(() => {
    if (snapshot.auth?.browserRunning && snapshot.auth.activePlatform) setRemotePlatform(snapshot.auth.activePlatform);
  }, [snapshot.auth?.activePlatform, snapshot.auth?.browserRunning]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (operation) return false;
    setOperation(name);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (cause) {
      setError({ cause });
      return false;
    } finally {
      setOperation(undefined);
    }
  };

  const connect = () => {
    return run('connect', async () => {
      broker.updateSettings({ endpoint });
      await broker.connect();
    });
  };

  const openLogin = async (platform: WebNovelMetadataCollectorAuthPlatform) => {
    const opened = await run(`open-${platform}`, () => broker.openAuthBrowser(platform));
    if (opened && remoteAuthBrowser) {
      setRemotePlatform(platform);
      setRemoteBrowserVisible(true);
    }
  };
  const finishLogin = (platform: WebNovelMetadataCollectorAuthPlatform) =>
    run(`enable-${platform}`, () => broker.setAuthPlatformEnabled(platform, true));
  const disableLogin = (platform: WebNovelMetadataCollectorAuthPlatform) =>
    run(`disable-${platform}`, () => broker.setAuthPlatformEnabled(platform, false));

  const resetEndpoint = () => setEndpoint(broker.resetSettings().endpoint);
  const closeRemoteBrowser = async () => {
    if (await run('close-auth', () => broker.closeAuthBrowser())) {
      setRemotePlatform(undefined);
      setRemoteBrowserVisible(false);
    }
  };
  const completeRemoteBrowser = async () => {
    if (remotePlatform && (await finishLogin(remotePlatform))) {
      setRemotePlatform(undefined);
      setRemoteBrowserVisible(false);
    }
  };
  return {
    snapshot,
    endpoint,
    setEndpoint,
    resetEndpoint,
    operation,
    error,
    remotePlatform,
    remoteBrowserVisible,
    setRemoteBrowserVisible,
    connected,
    managed,
    remoteAuthBrowser,
    directLoginPlatforms,
    authPlatforms,
    run,
    connect,
    openLogin,
    finishLogin,
    disableLogin,
    closeRemoteBrowser,
    completeRemoteBrowser,
    remoteEndpoint: isRemoteEndpoint(endpoint),
    progress: automation.progress,
    result: automation.result,
    automation,
    updateSettings: broker.updateSettings.bind(broker),
  };
}
export type WebNovelMetadataSettingsModel = ReturnType<typeof useWebNovelMetadataSettingsModel>;
