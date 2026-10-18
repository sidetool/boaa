import { afterEach, expect, it, vi } from 'vitest';
import type { ByeDpiProcess } from './byedpi-process.js';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceNetworkSettings } from './source-network-settings.js';
import { EncryptedSourceCredentialVault } from './source-credential-vault.js';
import { applyProxyChanges } from './outbound-proxy.js';
import { registerSourceNetworkSettingsRoutes } from '../routes/source-network-settings.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('persists a default, preserves legacy overrides and direct exceptions, and rejects stale writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boaa-network-'));
  roots.push(root);
  const vault = () => new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 42));
  let settings = createSourceNetworkSettings(vault(), 'http://operator:8080');
  expect(settings.resolve()).toBe('http://operator:8080/');
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.principal = { userId: 'fixture-admin', role: 'admin', authMethod: 'legacy-token' };
  });
  await registerSourceNetworkSettingsRoutes(app, settings);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/source-network-settings',
    payload: { revision: 0, defaultProxy: 'socks5://proxy:1080' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ revision: 1, defaultProxy: 'socks5://proxy:1080', origin: 'settings' });
  settings = createSourceNetworkSettings(vault(), 'http://operator:8080');
  expect(settings.resolve()).toBe('socks5://proxy:1080');
  expect(settings.resolve({ outboundProxy: 'http://legacy:8080' })).toBe('http://legacy:8080/');
  expect(settings.resolve({ proxyMode: 'direct', outboundProxy: 'http://legacy:8080' })).toBeUndefined();
  expect(settings.resolve({ proxyMode: 'inherit', outboundProxy: 'http://legacy:8080' })).toBe('socks5://proxy:1080');
  for (const [payload, status] of [
    [{ revision: 0, defaultProxy: '' }, 409],
    [{ revision: 1, defaultProxy: 'http://user:secret@proxy:8080' }, 400],
    [{ revision: 1, defaultProxy: 'ftp://proxy' }, 400],
  ] as const)
    expect((await app.inject({ method: 'PUT', url: '/api/source-network-settings', payload })).statusCode).toBe(status);
  expect(settings.read().revision).toBe(1);
  settings.save({ revision: 1, defaultProxy: '' });
  expect(settings.resolve()).toBeUndefined();
  settings.save({ revision: 2, defaultProxy: null });
  expect(settings.resolve()).toBe('http://operator:8080/');
  const options = { outboundProxy: 'http://legacy:8080' };
  applyProxyChanges(options, { __boaa_outbound_proxy: '' });
  expect(settings.resolve(options)).toBe('http://operator:8080/');
  expect(() => applyProxyChanges(options, { __boaa_proxy_mode: 'custom' })).toThrow(
    'compatibility_preferences_invalid',
  );
  await app.close();
});

it('allows encrypted Mangayomi caches to reopen and rejects oversized writes without replacing saved data', () => {
  const root = mkdtempSync(join(tmpdir(), 'boaa-vault-limit-'));
  roots.push(root);
  const vault = new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 1));
  const scope = JSON.stringify(['pkg', 'mangayomi-options', 'epoch']);
  const saved = { secret: JSON.stringify({ values: { status: '가'.repeat(30000), mapping: 'x'.repeat(54000) } }) };
  vault.write(scope, saved);
  expect(new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 1)).read(scope)).toEqual(saved);
  expect(() => vault.write(scope, { secret: 'x'.repeat(5 * 1024 * 1024) })).toThrow('source_vault_size_limit');
  expect(vault.read(scope)).toEqual(saved);
  expect(() => vault.write(JSON.stringify(['pkg', 'auth', 'epoch']), saved)).toThrow('source_vault_size_limit');
});

function networkFixture() {
  const root = mkdtempSync(join(tmpdir(), 'boaa-byedpi-settings-'));
  roots.push(root);
  const vault = new EncryptedSourceCredentialVault(root, Buffer.alloc(32, 5));
  let running = false;
  const process: ByeDpiProcess = {
    proxyUrl: 'socks5://api:1080',
    status: () => ({ available: true, running }),
    ensureRunning: vi.fn(async () => {
      running = true;
    }),
    stop: vi.fn(async () => {
      running = false;
    }),
  };
  const settings = createSourceNetworkSettings(vault, 'http://operator:8080', process);
  return {
    settings,
    process,
    vault,
    interrupt: () => {
      running = false;
    },
  };
}
it('uses built-in SOCKS for inherit, keeps the user proxy, persists the switch and honors direct/custom exceptions', async () => {
  const { settings, process, vault, interrupt } = networkFixture();
  expect(settings.read()).toMatchObject({ byedpi: { available: true, enabled: false, running: false } });
  const enabled = await settings.save({ revision: 0, defaultProxy: 'http://saved:8080', byedpiEnabled: true });
  expect(enabled).toMatchObject({
    revision: 1,
    defaultProxy: 'http://saved:8080/',
    effectiveProxy: 'socks5://api:1080',
    byedpi: { enabled: true, running: true },
  });
  expect(settings.resolve()).toBe('socks5://api:1080');
  expect(settings.resolve({ proxyMode: 'direct' })).toBeUndefined();
  expect(settings.resolve({ proxyMode: 'custom', outboundProxy: 'http://custom:8080' })).toBe('http://custom:8080/');
  expect(settings.resolve({ outboundProxy: 'socks5://legacy:1081' })).toBe('socks5://legacy:1081');
  await settings.save({ revision: 1, defaultProxy: 'http://saved:8081' });
  expect(settings.read().byedpi?.enabled).toBe(true);
  interrupt();
  expect(settings.read().byedpi).toMatchObject({ enabled: true, running: false });
  expect(settings.resolve()).toBe('socks5://api:1080');
  const reopened = createSourceNetworkSettings(vault, 'http://environment:8080', process);
  await reopened.initialize();
  expect(reopened.read().byedpi?.running).toBe(true);
  await reopened.save({ revision: 2, defaultProxy: 'http://saved:8081', byedpiEnabled: false });
  expect(reopened.resolve()).toBe('http://saved:8081/');
  expect(reopened.read().byedpi).toMatchObject({ enabled: false, running: false });
  await reopened.close();
});
it('commits only after health succeeds, serializes concurrent revisions, and returns actionable API failures', async () => {
  const { settings, process } = networkFixture();
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.principal = { userId: 'fixture-admin', role: 'admin', authMethod: 'legacy-token' };
  });
  await registerSourceNetworkSettingsRoutes(app, settings);
  vi.mocked(process.ensureRunning).mockRejectedValueOnce(new Error('byedpi_start_failed'));
  const failed = await app.inject({
    method: 'PUT',
    url: '/api/source-network-settings',
    payload: { revision: 0, defaultProxy: '', byedpiEnabled: true },
  });
  expect(failed.statusCode).toBe(503);
  expect(failed.json()).toEqual({ error: 'byedpi_start_failed' });
  expect(settings.read()).toMatchObject({
    revision: 0,
    defaultProxy: 'http://operator:8080/',
    byedpi: { enabled: false },
  });
  let finish!: () => void;
  vi.mocked(process.ensureRunning).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = settings.save({ revision: 0, defaultProxy: 'http://saved:8080', byedpiEnabled: true });
  const second = settings.save({ revision: 0, defaultProxy: '', byedpiEnabled: false });
  const conflict = expect(second).rejects.toThrow('source_network_conflict');
  await Promise.resolve();
  expect(settings.read().revision).toBe(0);
  finish();
  await first;
  await conflict;
  expect(settings.read()).toMatchObject({ revision: 1, byedpi: { enabled: true } });
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/source-network-settings',
    payload: { revision: 1, defaultProxy: '', byedpiEnabled: 'yes' },
  });
  expect(invalid.statusCode).toBe(400);
  expect((await app.inject({ url: '/api/source-network-settings' })).headers['cache-control']).toBe('no-store');
  await app.close();
  await settings.close();
});
it('keeps degraded persisted activation after restart and never resolves it as a direct default', async () => {
  const { settings, process, vault, interrupt } = networkFixture();
  await settings.save({ revision: 0, defaultProxy: '', byedpiEnabled: true });
  interrupt();
  vi.mocked(process.ensureRunning).mockRejectedValue(new Error('byedpi_start_failed'));
  const reopened = createSourceNetworkSettings(vault, undefined, process);
  await reopened.initialize();
  expect(reopened.read()).toMatchObject({
    revision: 1,
    effectiveProxy: 'socks5://api:1080',
    byedpi: { enabled: true, running: false },
  });
  expect(reopened.resolve()).toBe('socks5://api:1080');
  const unavailable = createSourceNetworkSettings(vault, undefined);
  expect(unavailable.read().byedpi).toMatchObject({ available: false, enabled: true, running: false });
  expect(() => unavailable.resolve()).toThrow('byedpi_unavailable');
  expect(unavailable.resolve({ proxyMode: 'direct' })).toBeUndefined();
  const empty = createSourceNetworkSettings(
    new EncryptedSourceCredentialVault(join(roots.at(-1)!, 'empty'), Buffer.alloc(32, 5)),
    undefined,
  );
  expect(() => empty.save({ revision: 0, defaultProxy: '', byedpiEnabled: true })).toThrow('byedpi_unavailable');
  await reopened.close();
});

it('persists direct mode independently of the saved proxy and restores it after reopening', async () => {
  const { settings, process, vault } = networkFixture();
  await settings.save({ revision: 0, defaultProxy: 'socks5://saved:1080', defaultMode: 'custom' });
  await settings.save({ revision: 1, defaultProxy: 'socks5://saved:1080', defaultMode: 'direct' });
  const reopened = createSourceNetworkSettings(vault, 'http://environment:8080', process);
  await reopened.initialize();
  expect(reopened.read()).toMatchObject({
    defaultMode: 'direct',
    defaultProxy: 'socks5://saved:1080',
    effectiveProxy: '',
  });
  expect(reopened.resolve()).toBeUndefined();
  await reopened.save({ revision: 2, defaultProxy: 'socks5://saved:1080', defaultMode: 'byedpi' });
  expect(reopened.resolve()).toBe('socks5://api:1080');
  await reopened.save({ revision: 3, defaultProxy: 'socks5://saved:1080', defaultMode: 'custom' });
  expect(reopened.resolve()).toBe('socks5://saved:1080');
  await reopened.close();
});

it('migrates legacy saved settings, preserves environment inheritance, and rejects conflicting mode fields', async () => {
  const { vault, process } = networkFixture();
  vault.write(JSON.stringify(['host:source-network', 'source-network', 'v1']), {
    secret: JSON.stringify({ revision: 4, defaultProxy: 'socks5://legacy:1080', byedpiEnabled: true }),
  });
  const settings = createSourceNetworkSettings(vault, 'http://operator:8080', process);
  expect(settings.read().defaultMode).toBe('byedpi');
  await settings.save({ revision: 4, defaultProxy: null, defaultMode: 'direct', byedpiEnabled: false });
  expect(settings.read()).toMatchObject({
    defaultMode: 'direct',
    defaultProxy: 'http://operator:8080/',
    origin: 'environment',
  });
  expect(settings.resolve()).toBeUndefined();
  await settings.save({ revision: 5, defaultProxy: null, byedpiEnabled: false });
  expect(settings.read().defaultMode).toBe('custom');
  expect(settings.resolve()).toBe('http://operator:8080/');
  expect(() => settings.save({ revision: 6, defaultProxy: '', defaultMode: 'custom' })).toThrow(
    'compatibility_preferences_invalid',
  );
  expect(() => settings.save({ revision: 6, defaultProxy: null, defaultMode: 'direct', byedpiEnabled: true })).toThrow(
    'compatibility_preferences_invalid',
  );
  await settings.close();
});
