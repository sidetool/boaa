import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture';
import type { VerifiedBoaaPackage } from '../../../../src/extensions/packages/package-archive';
import { createNodePackageExecution } from './node-package-execution';
import { createSourceNetworkSettings } from './source-network-settings';
import type { SourceCredentialVault } from './source-credential-vault';

const observed = vi.hoisted(() => [] as string[]);
vi.mock('./source-proxy-transport', () => ({
  createSourceProxyTransport: (proxy?: string) =>
    !proxy
      ? {}
      : {
          transport: async () => {
            observed.push(proxy);
            return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{}']) };
          },
        },
}));
afterEach(() => {
  observed.length = 0;
  vi.unstubAllEnvs();
});

it('routes real SDK broker requests through the saved default while respecting per-source direct/custom choices', async () => {
  vi.stubEnv('SOURCE_OUTBOUND_PROXY', 'http://environment:8080');
  const secrets = new Map<string, { secret: string }>();
  const vault: SourceCredentialVault = {
    read: (key) => secrets.get(key),
    write: (key, value) => {
      if (value) secrets.set(key, value);
    },
  };
  const network = createSourceNetworkSettings(vault);
  network.save({ revision: 0, defaultProxy: 'socks5://shared:1080' });
  const execution = createNodePackageExecution('self-host-gateway', {
    vault,
    transport: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => {
        observed.push('direct');
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{}']) };
      },
    },
  });
  const pkg = {
    manifest: examplePackageManifest(),
    digest: 'fixture',
    archive: new Blob(),
    source: `globalThis.boaaExtension=async(method,input,host)=>{await host.request('http.request',{url:'https://catalog.example/list',response:'text'});return {items:[]};};`,
  } as VerifiedBoaaPackage;
  const signal = AbortSignal.timeout(10000),
    source = 'org.example.catalog.source';
  const invoke = () => execution.invoke(pkg, 'source.listWorks', { sourceId: source }, signal, {}, 'epoch');
  await invoke();
  let revision = 0;
  const selections: Record<string, string>[] = [
    { __boaa_proxy_mode: 'direct' },
    { __boaa_proxy_mode: 'custom', __boaa_outbound_proxy: 'http://custom:8080' },
    { __boaa_proxy_mode: 'inherit' },
  ];
  for (const changes of selections) {
    await execution.preferences!(
      pkg,
      source,
      'epoch',
      { action: 'save', revision: revision++, changes, privateOrigins: [] },
      signal,
    );
    await invoke();
  }
  network.save({ revision: 1, defaultProxy: '' });
  await invoke();
  expect(observed).toEqual(['socks5://shared:1080', 'direct', 'http://custom:8080/', 'socks5://shared:1080', 'direct']);
});

it('allows member dynamic public endpoints without turning them into private network grants', async () => {
  const { SessionSourceCredentialVault } = await import('./source-credential-vault');
  const transport = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from(['{}']) }));
  const execution = createNodePackageExecution('self-host-gateway', {
    vault: new SessionSourceCredentialVault(),
    allowPrivateNetwork: false,
    network: createSourceNetworkSettings(undefined, ''),
    transport: {
      lookup: async (host) => [{ address: host === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
      transport,
    },
  });
  const sourceId = 'org.example.catalog.source';
  const pkg = {
    manifest: {
      ...examplePackageManifest(),
      preferences: [
        {
          sourceId,
          fields: [{ key: 'endpoint', title: 'Endpoint', kind: 'text', secret: false, networkOrigin: true }],
        },
      ],
    },
    digest: 'fixture',
    archive: new Blob(),
    source: `globalThis.boaaExtension=async(method,input,host)=>{const url=await host.request('preferences.get',{key:'endpoint'});await host.request('http.request',{url,response:'text'});return {items:[]};};`,
  } as VerifiedBoaaPackage;
  const signal = AbortSignal.timeout(10000);
  await execution.preferences!(
    pkg,
    sourceId,
    'epoch',
    { action: 'save', revision: 0, changes: { endpoint: 'https://public.example' }, privateOrigins: [] },
    signal,
  );
  await execution.invoke(pkg, 'source.listWorks', { sourceId }, signal, {}, 'epoch');
  expect(transport).toHaveBeenCalledTimes(1);
  await execution.preferences!(
    pkg,
    sourceId,
    'epoch',
    { action: 'save', revision: 1, changes: { endpoint: 'https://private.example' }, privateOrigins: [] },
    signal,
  );
  await expect(execution.invoke(pkg, 'source.listWorks', { sourceId }, signal, {}, 'epoch')).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(
    execution.preferences!(
      pkg,
      sourceId,
      'epoch',
      { action: 'save', revision: 2, changes: {}, privateOrigins: ['http://localhost'] },
      signal,
    ),
  ).rejects.toThrow('invalid_source_preferences');
});
