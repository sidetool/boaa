import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings, normalizeReaderSettings, normalizeRecentSearches } from '@boaa/reader-core/settings';
import { sharedReaderSettings, sharedReaderSettingsEqual } from '../../repositories/reader-settings-scope';
import { readerSettingsEqual } from '../../features/reader-settings/reader-settings-model';
import { getSettings, saveSettings, listSyncOutbox, resetReaderDbForTests } from '../../storage/db';
import { RemoteReaderRepository } from '../../repositories/remote-reader-repository';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { validateSettingsBody } from '../../../apps/server/src/routes/books/request-contracts';

beforeEach(() => resetReaderDbForTests());
it('normalizes bounded recent searches and includes their changes in settings synchronization', () => {
  expect(normalizeRecentSearches([' A ', 'a', '', 42, 'x'.repeat(201), 'Ｂ', 'b'])).toEqual(['A', 'Ｂ']);
  expect(normalizeReaderSettings({ recentSearches: [' a '] }).recentSearches).toEqual(['a']);
  const next = { ...defaultSettings, recentSearches: ['term'] };
  expect(sharedReaderSettings(next).recentSearches).toEqual(['term']);
  expect(readerSettingsEqual(defaultSettings, next)).toBe(false);
  expect(sharedReaderSettingsEqual(defaultSettings, next)).toBe(false);
  expect(validateSettingsBody({ recentSearches: Array.from({ length: 9 }, (_, i) => String(i)) }).ok).toBe(false);
  expect(validateSettingsBody({ recentSearches: ['x'.repeat(201)] }).ok).toBe(false);
  expect(validateSettingsBody({ recentSearches: [42] }).ok).toBe(false);
});

it('round-trips recent terms and clears through local storage, sync outbox and the remote settings validator', async () => {
  await saveSettings({ ...(await getSettings()), recentSearches: ['one', 'two'] });
  expect((await getSettings()).recentSearches).toEqual(['one', 'two']);
  expect(await listSyncOutbox()).not.toHaveLength(0);
  let saved = sharedReaderSettings(defaultSettings);
  const client = {
    readerSettingsScope: 'search-settings',
    getSettings: vi.fn(async () => ({ settings: { ...defaultSettings, ...saved } })),
    saveSettings: vi.fn(async (body) => {
      const result = validateSettingsBody(JSON.parse(JSON.stringify(body)));
      if (!result.ok) throw new Error(result.error);
      saved = sharedReaderSettings(result.value);
    }),
  } as unknown as RemoteApiClient;
  const remote = new RemoteReaderRepository(client);
  await remote.saveSettings({ ...(await getSettings()), recentSearches: ['one', 'two'] });
  expect((await new RemoteReaderRepository(client).getSettings()).recentSearches).toEqual(['one', 'two']);
  await remote.saveSettings({ ...(await remote.getSettings()), recentSearches: [] });
  expect((await remote.getSettings()).recentSearches).toEqual([]);
});
