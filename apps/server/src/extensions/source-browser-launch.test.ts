import type { Browser } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchSourceBrowser } from './source-browser-launch.js';
import { browserLaunchOptions } from '@boaa/browser-runtime';

vi.mock('@boaa/browser-runtime', () => ({
  browserEngine: () => 'camoufox',
  browserDriverVersion: () => '1.62.0',
  browserLaunchOptions: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('Camoufox source browser', () => {
  it('uses official options on local platforms without probing Chrome or Edge', async () => {
    vi.stubEnv('BOAA_SOURCE_BROWSER_ENDPOINT', '');
    vi.stubEnv('BOAA_SOURCE_BROWSER_EXECUTABLE', '/legacy/chromium');
    const options = { executablePath: '/camoufox', headless: true, env: { CAMOU_CONFIG_1: '{}' } };
    vi.mocked(browserLaunchOptions).mockResolvedValue(options);
    const browser = {} as Browser;
    const launch = vi.fn().mockResolvedValue(browser);
    expect(await launchSourceBrowser({ launch }, [], 'win32')).toBe(browser);
    expect(launch).toHaveBeenCalledExactlyOnceWith(options);
  });

  it('fails closed without selecting another engine when Camoufox is unavailable', async () => {
    vi.stubEnv('BOAA_SOURCE_BROWSER_ENDPOINT', '');
    vi.mocked(browserLaunchOptions).mockRejectedValue(new Error('source_browser_unavailable'));
    const launch = vi.fn();
    await expect(launchSourceBrowser({ launch })).rejects.toThrow('source_browser_unavailable');
    expect(launch).not.toHaveBeenCalled();
  });
});
