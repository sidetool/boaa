import { access } from 'node:fs/promises';
import type { BrowserType } from 'playwright-core';
import { readRuntimeJson, runtimeComponentEndpoint, runtimeComponentToken } from './runtime-component-client.js';

function configuredExecutable() {
  return (
    process.env.BOAA_SOURCE_BROWSER_EXECUTABLE ??
    process.env.MOYA_SOURCE_BROWSER_EXECUTABLE ??
    process.env.NOVELDESK_SOURCE_BROWSER_EXECUTABLE ??
    process.env.MOA_SOURCE_BROWSER_EXECUTABLE
  );
}

export function sourceBrowserUsesRemote() {
  return !!process.env.BOAA_SOURCE_BROWSER_ENDPOINT && !configuredExecutable();
}

/** Use an installed browser; Windows WebView2 alone is not an automation browser. */
export async function launchSourceBrowser(
  launcher: Pick<BrowserType, 'launch'> & Partial<Pick<BrowserType, 'connect'>>,
  args: string[],
  platform = process.platform,
  engine: 'chromium' | 'patchright' = 'chromium',
) {
  const configured = configuredExecutable();
  if (configured) return launcher.launch({ executablePath: configured, headless: true, args });
  const remote = process.env.BOAA_SOURCE_BROWSER_ENDPOINT;
  if (remote) {
    if (!launcher.connect) throw new Error('source_browser_unavailable');
    const endpoint = runtimeComponentEndpoint(remote);
    const headers = { Authorization: `Bearer ${await runtimeComponentToken()}` };
    const response = await fetch(new URL('/v1/browsers', endpoint), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, engine }),
      redirect: 'error',
      signal: AbortSignal.timeout(35000),
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
      engines?.[engine] !== '1.61.1' ||
      typeof manifest.wsPath !== 'string' ||
      !/^\/v1\/browsers\/[a-f0-9-]{36}\/ws$/.test(manifest.wsPath)
    )
      throw new Error('runtime_manifest_invalid');
    const websocket = new URL(manifest.wsPath, endpoint);
    websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:';
    return launcher.connect(websocket.href, { headers, timeout: 15000 });
  }
  if (platform === 'win32') {
    const failures: unknown[] = [];
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await launcher.launch({ channel, headless: true, args });
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, 'source_browser_unavailable');
  }
  for (const executablePath of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (
      await access(executablePath).then(
        () => true,
        () => false,
      )
    )
      return launcher.launch({ executablePath, headless: true, args });
  }
  return launcher.launch({ headless: true, args });
}
