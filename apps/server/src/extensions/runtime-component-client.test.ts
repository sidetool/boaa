import { afterEach, expect, it, vi } from 'vitest';
import { createManagedMetadataFetch } from './runtime-component-client.js';
import { launchSourceBrowser } from './source-browser-launch.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('authenticates only managed metadata endpoints and resolves the proxy per operation', async () => {
  let proxy: string | undefined = 'socks5://api:1080';
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const request = createManagedMetadataFetch({
    endpoint: 'http://runtime-metadata:8792',
    resolveDefaultProxy: () => proxy,
    env: { BOAA_RUNTIME_TOKEN: 'a'.repeat(64) },
    fetchImpl: upstream,
  });
  await request('http://runtime-metadata:8792/api/v1/resolve?q=synthetic');
  let headers = upstream.mock.calls[0][1]!.headers as Headers;
  expect(headers.get('Authorization')).toBe('Bearer ' + 'a'.repeat(64));
  expect(headers.get('X-Boaa-Outbound-Proxy')).toBe('socks5://api:1080');
  proxy = undefined;
  await request('http://runtime-metadata:8792/health');
  headers = upstream.mock.calls[1][1]!.headers as Headers;
  expect(headers.get('X-Boaa-Outbound-Proxy')).toBe('direct');
  await expect(request('http://external.example/api/v1/resolve')).rejects.toThrow('runtime_path_denied');
  await expect(request('http://runtime-metadata:8792/private')).rejects.toThrow('runtime_path_denied');
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('verifies the browser manifest and authenticates the WebSocket without local fallback', async () => {
  vi.stubEnv('BOAA_SOURCE_BROWSER_EXECUTABLE', '');
  vi.stubEnv('BOAA_SOURCE_BROWSER_ENDPOINT', 'http://runtime-browser:8791');
  vi.stubEnv('BOAA_RUNTIME_TOKEN', 'a'.repeat(64));
  vi.stubEnv('BOAA_RUNTIME_TOKEN_FILE', '');
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      schemaVersion: 1,
      protocolVersion: 1,
      component: 'browser',
      engine: 'chromium',
      engines: { chromium: '1.61.1' },
      wsPath: '/v1/browsers/12345678-1234-1234-1234-123456789012/ws',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const browser = {};
  const launch = vi.fn(),
    connect = vi.fn().mockResolvedValue(browser);
  expect(await launchSourceBrowser({ launch, connect }, [])).toBe(browser);
  expect(launch).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledWith(
    'ws://runtime-browser:8791/v1/browsers/12345678-1234-1234-1234-123456789012/ws',
    {
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64) },
      timeout: 15000,
    },
  );
  fetch.mockResolvedValueOnce(Response.json({ schemaVersion: 2 }));
  await expect(launchSourceBrowser({ launch, connect }, [])).rejects.toThrow('runtime_manifest_invalid');
  expect(launch).not.toHaveBeenCalled();
});
