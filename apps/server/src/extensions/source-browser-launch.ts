import { camoufoxLaunchOptions, BROWSER_ENGINE, BROWSER_DRIVER_VERSION } from '@boaa/browser-runtime';
import type { BrowserType } from 'playwright-core';
import { readRuntimeJson, runtimeComponentEndpoint, runtimeComponentToken } from './runtime-component-client.js';

export function sourceBrowserUsesRemote() {
  return !!process.env.BOAA_SOURCE_BROWSER_ENDPOINT && !process.env.BOAA_CAMOUFOX_EXECUTABLE;
}

/** Camoufox is the only source browser; local launches never discover a system browser. */
export async function launchSourceBrowser(
  launcher: Pick<BrowserType, 'launch'> & Partial<Pick<BrowserType, 'connect'>>,
  _args: string[] = [],
  _platform = process.platform,
  engine: 'camoufox' = BROWSER_ENGINE,
  signal?: AbortSignal,
) {
  const remote = sourceBrowserUsesRemote() && process.env.BOAA_SOURCE_BROWSER_ENDPOINT;
  if (remote) {
    if (!launcher.connect) throw new Error('source_browser_unavailable');
    const endpoint = runtimeComponentEndpoint(remote);
    const headers = { Authorization: `Bearer ${await runtimeComponentToken()}` };
    const response = await fetch(new URL('/v1/browsers', endpoint), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, engine }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('source_browser_unavailable');
    }
    const manifest = await readRuntimeJson(response);
    const engines = manifest.engines as Record<string, unknown> | undefined;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.protocolVersion !== 1 ||
      manifest.component !== 'browser' ||
      manifest.engine !== engine ||
      engines?.[engine] !== BROWSER_DRIVER_VERSION ||
      typeof manifest.wsPath !== 'string' ||
      !/^\/v1\/browsers\/[a-f0-9-]{36}\/ws$/.test(manifest.wsPath)
    )
      throw new Error('runtime_manifest_invalid');
    const websocket = new URL(manifest.wsPath, endpoint);
    websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:';
    return launcher.connect(websocket.href, { headers, timeout: 15000 });
  }
  return launcher.launch(await camoufoxLaunchOptions());
}
