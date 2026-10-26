import 'fake-indexeddb/auto';
import { validateSettingsBody } from '../../../apps/server/src/routes/books/request-contracts';
import { sharedReaderSettings } from '../../repositories/reader-settings-scope';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReaderSettings } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';
import { RemoteReaderRepository } from '../../repositories/remote-reader-repository';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { deviceReaderSettings } from '../../repositories/reader-settings-scope';
import { resetReaderDbForTests } from '../../storage/db';
import { resolveReadingProfile, updateBookReadingProfile, updateGlobalReadingProfile } from './reading-profile';
import { useReaderSettingsDraft, type ReaderSettingsController } from './useReaderSettingsDraft';

beforeEach(() => resetReaderDbForTests());

async function fixture() {
  let server = structuredClone(defaultSettings);
  const client = {
    readerSettingsScope: 'settings-review',
    getSettings: vi.fn(async () => ({ settings: structuredClone(server) })),
    saveSettings: vi.fn(async (patch: Partial<ReaderSettings>) => {
      const parsed = validateSettingsBody(structuredClone(patch));
      if (!parsed.ok) throw new Error(parsed.error);
      server = { ...server, ...sharedReaderSettings(parsed.value) };
    }),
  };
  const repository = new RemoteReaderRepository(client as unknown as RemoteApiClient);
  let saved: ReaderSettings = {
    ...updateGlobalReadingProfile(defaultSettings, {
      theme: 'custom',
      foreground: '#abcdef',
      background: '#123456',
      fontId: 'builtin-mono',
      fontSize: 27,
      fontWeight: 600,
      lineHeight: 2.2,
      letterSpacing: 0.12,
      wordSpacing: 0.2,
      paragraphSpacing: 1.6,
      marginX: 16,
      marginY: 8,
      contentWidth: 900,
      brightness: 0.7,
      modeLock: 'paginated',
      pageTurnMotion: 'slide',
      pageSpread: 'double',
      scrollChapterTransition: 'continuous',
    }),
    applicationTheme: 'sepia',
    keepScreenChrome: true,
    hideAppLogo: true,
    showLibraryReadingCounts: true,
    showLibraryFormatBadge: false,
    showHomeSourceRanks: true,
    sourceProgressBasis: 'downloaded',
    startupScreen: { kind: 'library', shelfId: 'fixture-shelf' },
    gestureBindings: { ...defaultSettings.gestureBindings, tapLeft: 'none' },
    ttsVoiceURI: 'fixture-device-voice',
    ttsSpeed: 1.2,
    ttsPlayback: {
      ...defaultSettings.ttsPlayback,
      voiceSource: 'server',
      serverVoiceId: 'fixture:voice',
      rate: 1.2,
      plainChunking: 'batch',
      plainBatchCharacters: 1200,
    },
    ttsBookOverrides: { 'book-a': { rate: 1.4, plainBatchCharacters: 300 } },
    downloadPolicy: { autoNext: true, nextCount: 3, retentionEnabled: true, keepRead: 10 },
    recentSearches: ['fixture query'],
    aiWorkflows: { schemaVersion: 1, defaultWorkflowId: 'fixture.workflow', bookOverrides: {} },
  };
  saved = updateBookReadingProfile(saved, 'book-a', { fontSize: 32, theme: 'sepia', marginX: 5 });
  await repository.saveSettings(saved);
  saved = await repository.getSettings();
  client.saveSettings.mockClear();
  return {
    client,
    repository,
    saved,
    reopen: () => new RemoteReaderRepository(client as unknown as RemoteApiClient).getSettings(),
  };
}

it.each(['home', 'appearance', 'tts'] as const)(
  'preserves all other settings through delayed startup, %s edit, and fresh repository',
  async (edit) => {
    const f = await fixture();
    let controller!: ReaderSettingsController;
    const options = {
      repository: f.repository,
      initialSettings: defaultSettings,
      initialSettingsLoaded: false,
      onSaved: vi.fn(),
      onSaveError: vi.fn(),
      notify: vi.fn(),
    };
    function Harness() {
      controller = useReaderSettingsDraft(options);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Harness />);
    });
    try {
      await act(async () => {
        if (edit === 'home')
          controller.updateSettings({ homeRows: [{ id: 'favorites', kind: 'favorites', visible: false }] });
        if (edit === 'appearance')
          controller.updateSettings((previous) => updateGlobalReadingProfile(previous, { fontSize: 29 }));
        if (edit === 'tts')
          controller.updateSettings((previous) => ({
            ...previous,
            ttsSpeed: 1.6,
            ttsPlayback: { ...previous.ttsPlayback, rate: 1.6 },
          }));
        await controller.flush();
      });
      expect(f.client.saveSettings).not.toHaveBeenCalled();
      expect(await f.reopen()).toEqual(f.saved);
      await act(async () => {
        controller.setPersistedSettings(await f.repository.getSettings());
        await controller.flush();
      });
      const expected =
        edit === 'appearance'
          ? updateGlobalReadingProfile(f.saved, { fontSize: 29 })
          : edit === 'home'
            ? { ...f.saved, homeRows: [{ id: 'favorites', kind: 'favorites' as const, visible: false }] }
            : { ...f.saved, ttsSpeed: 1.6, ttsPlayback: { ...f.saved.ttsPlayback, rate: 1.6 } };
      expect(controller.settings).toEqual(expected);
      await act(async () => renderer.unmount());
      const reopened = await f.reopen();
      expect(reopened).toEqual(expected);
      expect(deviceReaderSettings(reopened)).toEqual(deviceReaderSettings(expected));
      expect(resolveReadingProfile(reopened, 'book-a')).toMatchObject({ fontSize: 32, theme: 'sepia', marginX: 5 });
      expect(resolveReadingProfile(reopened, 'book-b')).toEqual(resolveReadingProfile(expected));
      expect(resolveReadingProfile(reopened, 'book-a')).toEqual(resolveReadingProfile(expected, 'book-a'));
      expect(f.client.saveSettings).toHaveBeenCalledTimes(edit === 'appearance' ? 0 : 1);
      for (const [payload] of f.client.saveSettings.mock.calls) {
        expect(payload).not.toHaveProperty('readingProfile');
        expect(payload).not.toHaveProperty('readingBookOverrides');
      }
    } finally {
      act(() => renderer.unmount());
    }
  },
);
