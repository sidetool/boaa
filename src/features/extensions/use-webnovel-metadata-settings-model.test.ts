import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import {
  useWebNovelMetadataSettingsModel,
  type WebNovelMetadataSettingsModel,
} from './use-webnovel-metadata-settings-model';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import type { BookEnrichmentAutomationController } from '../book-enrichment/useBookEnrichmentAutomation';
import { WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS } from '../../services/webnovel-metadata-collector-client';
it('saves endpoint before connecting, exposes failures and closes the remote authentication workflow', async () => {
  const snapshot = {
    connectionState: 'connected',
    settings: { endpoint: 'http://localhost:8000' },
    health: { capabilities: { adultAuth: { browserPresentation: 'remote_frame' } } },
  };
  const updateSettings = vi.fn();
  const connect = vi.fn(async () => {
    expect(updateSettings).toHaveBeenCalledWith({ endpoint: 'https://collector.example' });
  });
  const broker = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    updateSettings,
    connect,
    openAuthBrowser: vi.fn(async () => {}),
    closeAuthBrowser: vi.fn(async () => {}),
    setAuthPlatformEnabled: vi.fn(async () => {}),
    resetSettings: () => ({ endpoint: 'http://localhost:8000' }),
  } as unknown as WebNovelMetadataCollectorBroker;
  const automation = { progress: { state: 'idle' } } as BookEnrichmentAutomationController;
  let model!: WebNovelMetadataSettingsModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useWebNovelMetadataSettingsModel(broker, automation);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  act(() => model.setEndpoint('https://collector.example'));
  await act(async () => {
    expect(await model.connect()).toBe(true);
  });
  expect(model.remoteEndpoint).toBe(true);
  const cause = new Error('offline');
  connect.mockRejectedValueOnce(cause);
  await act(async () => {
    expect(await model.connect()).toBe(false);
  });
  expect(model.error?.cause).toBe(cause);
  const platform = WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS[0];
  await act(async () => {
    await model.openLogin(platform);
  });
  expect(model.remoteBrowserVisible).toBe(true);
  await act(async () => {
    await model.completeRemoteBrowser();
  });
  expect(broker.setAuthPlatformEnabled).toHaveBeenCalledWith(platform, true);
  expect(model.remoteBrowserVisible).toBe(false);
  expect(model.remotePlatform).toBeUndefined();
  act(() => model.resetEndpoint());
  expect(model.remoteEndpoint).toBe(false);
  act(() => renderer.unmount());
});
