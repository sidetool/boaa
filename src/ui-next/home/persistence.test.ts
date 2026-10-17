import 'fake-indexeddb/auto';
import { validateSettingsBody } from '../../../apps/server/src/routes/books/request-contracts';
import { sharedReaderSettings } from '../../repositories/reader-settings-scope';
import { beforeEach, expect, it, vi } from 'vitest';
import { getSettings, saveSettings, listSyncOutbox, resetReaderDbForTests } from '../../storage/db';
import { RemoteReaderRepository } from '../../repositories/remote-reader-repository';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { defaultSettings } from '../../repositories/reader-defaults';
import type { SharedReaderSettings } from '../../repositories/reader-settings-scope';
import type { HomeRowConfig } from './contract';

beforeEach(() => resetReaderDbForTests());
const homeRows: HomeRowConfig[] = [
  {
    id: 'source-one',
    kind: 'source',
    visible: true,
    section: { sourceId: 'fixture.source', mode: 'popular', title: 'One', filters: [{ position: 0, value: 1 }] },
  },
  {
    id: 'source-two',
    kind: 'source',
    visible: false,
    section: {
      sourceId: 'fixture.source',
      mode: 'latest',
      title: 'Two',
      filters: [{ position: 0, value: 2 }],
      summary: 'Filtered',
    },
  },
  { id: 'unread', kind: 'unread', visible: false },
  { id: 'discovery', kind: 'discovery', visible: true, discoveryTabId: JSON.stringify(['tab', 'section']) },
];
it('persists layout locally and creates synchronization work', async () => {
  await saveSettings({ ...(await getSettings()), homeRows });
  expect((await getSettings()).homeRows).toEqual(homeRows);
  expect(await listSyncOutbox()).not.toHaveLength(0);
  await saveSettings({ ...(await getSettings()), homeRows: [] });
  expect((await getSettings()).homeRows).toEqual([]);
});
it('sends layout through the self-host settings API and reads it after repository recreation', async () => {
  let saved: SharedReaderSettings = { id: 'reader-settings' };
  const client = {
    readerSettingsScope: 'home-layout-test',
    getSettings: vi.fn(async () => ({ settings: { ...defaultSettings, ...saved } })),
    saveSettings: vi.fn(async (value: SharedReaderSettings) => {
      const parsed = validateSettingsBody(JSON.parse(JSON.stringify(value)));
      if (!parsed.ok) throw new Error(parsed.error);
      saved = sharedReaderSettings(parsed.value);
    }),
  };
  const repository = new RemoteReaderRepository(client as unknown as RemoteApiClient);
  await repository.saveSettings({ ...(await repository.getSettings()), homeRows, startupScreen: { kind: 'home' } });
  expect(client.saveSettings).toHaveBeenCalledOnce();
  expect(saved.homeRows).toEqual(homeRows);
  expect(saved).not.toHaveProperty('startupScreen');
  expect((await new RemoteReaderRepository(client as unknown as RemoteApiClient).getSettings()).homeRows).toEqual(
    homeRows,
  );
});

it.each(
  [
    [],
    [
      { id: 'shelf', kind: 'shelf', shelfId: 's1', visible: false },
      { id: 'discovery', kind: 'discovery', discoveryTabId: '["tab","section"]', visible: true },
      { id: 'new', kind: 'recently-added', visible: true },
    ],
  ].map((rows) => ({ rows })),
)('preserves explicit row configuration through server validation: $rows', ({ rows }) => {
  const parsed = validateSettingsBody({ ...defaultSettings, homeRows: rows });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(sharedReaderSettings(parsed.value).homeRows).toEqual(rows);
});
