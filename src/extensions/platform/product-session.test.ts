import { afterEach, expect, it, vi } from 'vitest';
import { loadPluginDeployment, validatePluginDeployment } from './product-session';
afterEach(() => vi.unstubAllGlobals());
const deployment = {
  version: 1,
  origin: 'https://boaa.test',
  serverId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  libraryId: '00000000-0000-4000-8000-000000000003',
  worker: '/plugin-runtime/controller-worker.js',
  wasm: '/plugin-runtime/quickjs.wasm',
  shell: '/plugin-runtime/shell',
};
it('requires server-provided scope and fixed same-origin runtime assets', () => {
  expect(validatePluginDeployment(deployment, 'https://boaa.test')).toEqual(deployment);
  for (const patch of [
    { origin: 'https://evil.test' },
    { serverId: 'username' },
    { worker: 'https://evil.test/worker.js' },
    { shell: '/api/arbitrary-html' },
    { version: 2 },
  ])
    expect(() => validatePluginDeployment({ ...deployment, ...patch }, 'https://boaa.test')).toThrow(
      'PLUGIN_DEPLOYMENT_MISMATCH',
    );
});

it('uses the proxied API base and same-origin session cookies for plugin context', async () => {
  vi.stubGlobal('location', { href: 'https://boaa.test/library', origin: 'https://boaa.test' });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(deployment), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await loadPluginDeployment('/api', signal)).toEqual(deployment);
  expect(fetcher).toHaveBeenCalledWith(new URL('https://boaa.test/api/plugins/context'), {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
});

it.each([
  [404, 'PLUGIN_DEPLOYMENT_DISABLED'],
  [401, 'PLUGIN_ACCOUNT_UNAVAILABLE'],
] as const)('distinguishes an unconfigured deployment from an invalid session (%s)', async (status, error) => {
  vi.stubGlobal('location', { href: 'https://boaa.test/', origin: 'https://boaa.test' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status })),
  );
  await expect(loadPluginDeployment('/api', new AbortController().signal)).rejects.toThrow(error);
});
