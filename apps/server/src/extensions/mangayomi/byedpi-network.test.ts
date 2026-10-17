import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MangayomiExtensionHost } from './host.js';
import { EncryptedSourceCredentialVault } from '../source-credential-vault.js';
import { createSourceNetworkSettings } from '../source-network-settings.js';
import { fixtureRow } from './test-fixture.js';
import type { compatibilityHttp } from './http.js';

it('uses built-in transport for JS lists and covers and refreshes cached cover bytes when the effective proxy changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-js-byedpi-fixture-'));
  const vault = new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 8));
  let running = false;
  const network = createSourceNetworkSettings(vault, undefined, {
    proxyUrl: 'socks5://api:1080',
    status: () => ({ available: true, running }),
    ensureRunning: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
  });
  await network.save({ revision: 0, defaultProxy: 'http://saved:8080', byedpiEnabled: true });
  const observed: (string | undefined)[] = [];
  const script = `class DefaultExtension extends MProvider {
    async getPopular(){
      await new Client().get('https://catalog.example/list');
      return {list:[{name:'Fixture',link:'/work',imageUrl:'https://catalog.example/cover.jpg'}],hasNextPage:false};
    }
  }`;
  const transport: typeof compatibilityHttp = async (input, _signal, _origins, _max, proxy) => {
    if (input.url.includes('catalog.example')) observed.push(proxy);
    return {
      bytes: input.url.endsWith('.json')
        ? Buffer.from(JSON.stringify([fixtureRow]))
        : input.url.endsWith('.js')
          ? Buffer.from(script)
          : input.url.endsWith('.jpg')
            ? Buffer.from([255, 216, 255, 217])
            : Buffer.from('{}'),
      statusCode: 200,
      contentType: 'text/plain',
      headers: {},
      url: input.url,
    };
  };
  const host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport, network);
  try {
    const repo = 'https://repo.example/index.json',
      signal = AbortSignal.timeout(10000);
    await host.refreshRepository(repo, signal);
    const entry = host.snapshot().repositories[0].entries[0];
    const plan = await host.inspect(repo, entry.pkg, entry.code, signal);
    await host.install(plan.id, plan.revision, signal);
    const source = host.catalog.getSources()[0].descriptor.id;
    const list = await host.catalog.invoke(source, 'source.listWorks', {}, signal);
    const input = { workId: list.result.items[0].id };
    await host.catalog.invoke(source, 'source.getCover', input, signal);
    await host.catalog.invoke(source, 'source.getCover', input, signal);
    expect(observed).toEqual(['socks5://api:1080', 'socks5://api:1080']);
    await network.save({ revision: 1, defaultProxy: 'http://saved:8080', byedpiEnabled: false });
    await host.catalog.invoke(source, 'source.listWorks', {}, signal);
    await host.catalog.invoke(source, 'source.getCover', input, signal);
    expect(observed.slice(-2)).toEqual(['http://saved:8080/', 'http://saved:8080/']);
    for (const [changes, proxy] of [
      [{ __boaa_proxy_mode: 'direct' }, undefined],
      [{ __boaa_proxy_mode: 'custom', __boaa_outbound_proxy: 'socks5://custom:1081' }, 'socks5://custom:1081'],
    ] as const) {
      await network.save({ revision: network.read().revision, defaultProxy: '', byedpiEnabled: true });
      await host.savePreferences(entry.pkg, host.snapshot().revision, changes, []);
      await host.catalog.invoke(source, 'source.listWorks', {}, signal);
      await host.catalog.invoke(source, 'source.getCover', input, signal);
      expect(observed.slice(-2)).toEqual([proxy, proxy]);
    }
  } finally {
    host.close();
    await network.close();
    await rm(root, { recursive: true, force: true });
  }
});
