import { expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { compatibleDatabaseUrl } from './pool.js';

it('prefers the new default and probes the old database only for missing defaults', async () => {
  const config = loadConfig({});
  const probe = vi.fn(async (_url: string) => undefined);
  expect(await compatibleDatabaseUrl(config, probe)).toBe(config.databaseUrl);
  expect(probe).toHaveBeenCalledTimes(1);
  probe.mockRejectedValueOnce(Object.assign(new Error('missing role'), { code: '28000' }));
  expect(await compatibleDatabaseUrl(config, probe)).toBe(config.legacyDatabaseUrl);
  expect(probe.mock.calls.map(([url]) => url).slice(1)).toEqual([config.databaseUrl, config.legacyDatabaseUrl]);
});
it('honors explicit database configuration and never falls back on network errors', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://operator@localhost/custom' });
  const probe = vi.fn(async (_url: string) => undefined);
  expect(await compatibleDatabaseUrl(config, probe)).toBe(config.databaseUrl);
  expect(probe).not.toHaveBeenCalled();
  const error = Object.assign(new Error('network'), { code: 'ECONNREFUSED' });
  probe.mockRejectedValueOnce(error);
  await expect(compatibleDatabaseUrl(loadConfig({}), probe)).rejects.toBe(error);
  expect(probe).toHaveBeenCalledTimes(1);
});

it('retains custom passwords and roles in generated Compose compatibility settings', () => {
  const config = loadConfig({
    PGHOST: 'postgres',
    PGUSER: 'boaa',
    PGPASSWORD: 'synthetic@:/password',
    PGDATABASE: 'boaa',
    BOAA_LEGACY_DATABASE_URL: 'auto',
    BOAA_LEGACY_PGUSER: 'noveldesk',
    BOAA_LEGACY_PGPASSWORD: 'synthetic@:/password',
    BOAA_LEGACY_PGDATABASE: 'noveldesk',
  });
  const url = new URL(config.legacyDatabaseUrl!);
  expect(url.hostname).toBe('postgres');
  expect(url.username).toBe('noveldesk');
  expect(decodeURIComponent(url.password)).toBe('synthetic@:/password');
  expect(url.pathname).toBe('/noveldesk');
  expect(loadConfig({ BOAA_LEGACY_DATABASE_URL: '' }).legacyDatabaseUrl).toBeUndefined();
});
