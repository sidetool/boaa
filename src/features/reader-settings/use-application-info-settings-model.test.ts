import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useApplicationInfoSettingsModel,
  type ApplicationInfoSettingsModel,
} from './use-application-info-settings-model';
vi.mock('../../app/runtime/RuntimeProvider', () => ({
  useOptionalAppRuntime: () => ({ readerRuntime: { mode: 'remote', apiBaseUrl: '/prefix/api' } }),
}));
afterEach(() => vi.unstubAllGlobals());
it('exposes runtime capabilities and server access without choosing display text', () => {
  vi.stubGlobal('window', { location: { href: 'https://reader.example/' } });
  vi.stubGlobal('navigator', { mediaSession: {} });
  let model!: ApplicationInfoSettingsModel;
  function Harness() {
    model = useApplicationInfoSettingsModel({
      kind: 'browser',
      hasTauri: false,
      isMobileWebView: false,
      userAgent: 'test',
    });
    return null;
  }
  const renderer = create(createElement(Harness));
  expect(model.webAccessUrl).toBe('https://reader.example/prefix/');
  expect(model.mediaSessionAvailable).toBe(true);
  expect(model.isAndroid).toBe(false);
  expect(model.productAvailable).toBe(false);
  act(() => renderer.unmount());
});
