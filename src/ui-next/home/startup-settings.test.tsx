import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { HomeWorkspace } from './HomeWorkspace';
import {
  useReaderSettingsDraft,
  type ReaderSettingsController,
} from '../../features/reader-settings/useReaderSettingsDraft';
import { defaultSettings } from '../../repositories/reader-defaults';
import { model } from '../test-fixtures';
import { appendPluginHomeRows } from './config';
import type { HomePluginSection } from './plugin-home';

const sections = vi.hoisted(() => [
  {
    pluginId: 'fixture.discovery',
    installationId: 'fixture-install',
    digest: 'fixture',
    revision: 1,
    pluginName: 'Fixture',
    section: { id: 'rank', title: 'Fixture list' },
  },
]);
vi.mock('./usePluginHome', () => ({ usePluginHome: () => ({ sections, row: vi.fn() }) }));
vi.mock('./useHomeDiscovery', () => ({ useHomeDiscovery: () => undefined }));
vi.mock('../../features/book-workspace/BookWorkspaceScreens', () => ({ BookWorkspaceScreens: () => null }));

it.each([true, false])(
  'does not let faster plugin discovery overwrite startup TTS settings (existing row: %s)',
  async (existing) => {
    const rows = existing
      ? appendPluginHomeRows([], sections as HomePluginSection[]).map((row) => ({ ...row, visible: false }))
      : [];
    const saved = {
      ...defaultSettings,
      homeRows: rows,
      ttsSpeed: 1.2,
      ttsPlayback: {
        ...defaultSettings.ttsPlayback,
        voiceSource: 'server' as const,
        serverVoiceId: 'fixture:voice',
        plainChunking: 'batch' as const,
        rate: 1.2,
        chapterEndBehavior: 'continue' as const,
      },
    };
    const saveSettings = vi.fn(async () => undefined);
    const options = {
      repository: { saveSettings },
      initialSettings: defaultSettings,
      initialSettingsLoaded: false,
      onSaved: vi.fn(),
      onSaveError: vi.fn(),
      notify: vi.fn(),
    };
    let controller!: ReaderSettingsController;
    function Harness({ status }: { status: 'loading' | 'ready' | 'failed' }) {
      controller = useReaderSettingsDraft(options);
      const props = {
        homeSettings: controller,
        bootstrap: { status, retry: vi.fn() },
        projection: { libraryCollection: model([]).collection },
        externalSources: { libraryWorks: [], sources: [] },
        libraryManagement: { memberships: [] },
        state: {},
      } as unknown as Parameters<typeof HomeWorkspace>[0];
      return <HomeWorkspace {...props} />;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness status="loading" />);
    });
    try {
      await act(async () => controller.flush());
      expect(controller.settings.homeRows).toBeUndefined();
      expect(saveSettings).not.toHaveBeenCalled();
      await act(async () => renderer.update(<Harness status="failed" />));
      await act(async () => controller.flush());
      expect(saveSettings).not.toHaveBeenCalled();
      await act(async () => {
        controller.setPersistedSettings(saved);
        renderer.update(<Harness status="ready" />);
      });
      await act(async () => controller.flush());
      expect(controller.settings.ttsPlayback).toEqual(saved.ttsPlayback);
      expect(controller.settings.ttsSpeed).toBe(1.2);
      if (existing) {
        expect(controller.settings.homeRows).toEqual(rows);
        expect(saveSettings).not.toHaveBeenCalled();
      } else {
        expect(saveSettings).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ ttsSpeed: 1.2, ttsPlayback: saved.ttsPlayback }),
        );
        expect(controller.settings.homeRows).toHaveLength(1);
      }
    } finally {
      act(() => renderer.unmount());
    }
  },
);
