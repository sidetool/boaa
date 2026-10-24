import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { useReaderSettingsDraft, type ReaderSettingsController } from './useReaderSettingsDraft';

it('commits device settings without refreshing sync, and still refreshes after a shared change', async () => {
  const saveSettings = vi.fn(async () => undefined);
  const onSaved = vi.fn();
  const options = {
    repository: { saveSettings },
    initialSettings: defaultSettings,
    onSaved,
    onSaveError: vi.fn(),
    notify: vi.fn(),
  };
  let controller!: ReaderSettingsController;
  function Harness() {
    controller = useReaderSettingsDraft(options);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    controller.updateSettings({ fontSize: 28 });
    await controller.flush();
  });
  expect(saveSettings).toHaveBeenCalledOnce();
  expect(controller.persistedSettings.fontSize).toBe(28);
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => {
    controller.updateSettings({ ttsSpeed: 1.5 });
    await controller.flush();
  });
  expect(onSaved).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
});

it('ignores an older refresh after a newer edit has already finished saving', async () => {
  let controller!: ReaderSettingsController;
  const options = {
    repository: { saveSettings: vi.fn(async () => undefined) },
    initialSettings: defaultSettings,
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
  let finish!: (value: typeof defaultSettings) => void;
  let refresh!: Promise<unknown>;
  await act(async () => {
    refresh = controller.refreshSettings(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    controller.updateSettings({ homeRows: [{ id: 'unread', kind: 'unread', visible: false }] });
    await controller.flush();
  });
  await act(async () => {
    finish(defaultSettings);
    await refresh;
  });
  expect(controller.settings.homeRows).toEqual([{ id: 'unread', kind: 'unread', visible: false }]);
  expect(controller.isDirty).toBe(false);
  act(() => renderer.unmount());
});

it('waits for authoritative startup settings before saving automatic home edits', async () => {
  const saved = {
    ...defaultSettings,
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
  const repository = { saveSettings: vi.fn(async () => undefined) };
  let controller!: ReaderSettingsController;
  const options = {
    repository,
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
      controller.updateSettings((previous) => ({
        ...previous,
        homeRows: [{ id: 'unread', kind: 'unread', visible: false }],
      }));
      await controller.flush();
    });
    expect(repository.saveSettings).not.toHaveBeenCalled();
    await act(async () => {
      controller.setPersistedSettings(saved);
      await controller.flush();
    });
    expect(repository.saveSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ttsSpeed: 1.2,
        ttsPlayback: saved.ttsPlayback,
        homeRows: [{ id: 'unread', kind: 'unread', visible: false }],
      }),
    );
    expect(controller.settings.ttsPlayback).toEqual(saved.ttsPlayback);
    expect(controller.isDirty).toBe(false);
  } finally {
    act(() => renderer.unmount());
  }
});

it('never flushes placeholders if bootstrap fails or the app closes before settings load', async () => {
  let controller!: ReaderSettingsController;
  const saveSettings = vi.fn(async () => undefined);
  const options = {
    repository: { saveSettings },
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
  await act(async () => {
    controller.updateSettings({ recentSearches: ['fixture'] });
    controller.retrySave();
    controller.closePanel();
    await controller.flush();
  });
  await act(async () => renderer.unmount());
  expect(saveSettings).not.toHaveBeenCalled();
});

it('rebases an explicit default-valued startup edit without resetting the other saved TTS fields', async () => {
  let controller!: ReaderSettingsController;
  const saveSettings = vi.fn(async () => undefined);
  const options = {
    repository: { saveSettings },
    initialSettings: defaultSettings,
    initialSettingsLoaded: false,
    onSaved: vi.fn(),
    onSaveError: vi.fn(),
    notify: vi.fn(),
  };
  const saved = {
    ...defaultSettings,
    ttsSpeed: 1.2,
    ttsPlayback: {
      ...defaultSettings.ttsPlayback,
      rate: 1.2,
      voiceSource: 'server' as const,
      serverVoiceId: 'fixture:voice',
      plainChunking: 'batch' as const,
    },
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
      controller.updateSettings((previous) => ({
        ...previous,
        ttsSpeed: 1,
        ttsPlayback: { ...previous.ttsPlayback, rate: 1 },
      }));
      controller.setPersistedSettings(saved);
      await controller.flush();
    });
    expect(saveSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ttsSpeed: 1,
        ttsPlayback: { ...saved.ttsPlayback, rate: 1 },
      }),
    );
    await act(async () => {
      controller.updateSettings((previous) => previous);
      await controller.flush();
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  } finally {
    act(() => renderer.unmount());
  }
});

it('ignores delayed hydration and queued startup edits from a replaced repository', async () => {
  let controller!: ReaderSettingsController;
  const first = { saveSettings: vi.fn(async () => undefined) };
  const second = { saveSettings: vi.fn(async () => undefined) };
  const callbacks = { onSaved: vi.fn(), onSaveError: vi.fn(), notify: vi.fn() };
  function Harness({ repository }: { repository: typeof first }) {
    controller = useReaderSettingsDraft({
      ...callbacks,
      repository,
      initialSettings: defaultSettings,
      initialSettingsLoaded: false,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness repository={first} />);
  });
  try {
    const oldCommit = controller.setPersistedSettings;
    await act(async () => controller.updateSettings({ recentSearches: ['old account'] }));
    await act(async () => renderer.update(<Harness repository={second} />));
    await act(async () => oldCommit({ ...defaultSettings, ttsSpeed: 1.8 }));
    await act(async () => {
      controller.setPersistedSettings({ ...defaultSettings, ttsSpeed: 1.3 });
      await controller.flush();
    });
    expect(controller.settings.ttsSpeed).toBe(1.3);
    expect(controller.settings.recentSearches).toBeUndefined();
    expect(first.saveSettings).not.toHaveBeenCalled();
    expect(second.saveSettings).not.toHaveBeenCalled();
  } finally {
    act(() => renderer.unmount());
  }
});

it.each(['success', 'failure'])(
  'ignores an old repository save finishing with %s after account replacement',
  async (outcome) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const first = { saveSettings: vi.fn(() => pending) };
    const second = { saveSettings: vi.fn(async () => undefined) };
    const callbacks = { onSaved: vi.fn(), onSaveError: vi.fn(), notify: vi.fn() };
    let controller!: ReaderSettingsController;
    function Harness({ repository }: { repository: typeof first }) {
      controller = useReaderSettingsDraft({
        ...callbacks,
        repository,
        initialSettings: defaultSettings,
        initialSettingsLoaded: false,
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness repository={first} />);
    });
    try {
      await act(async () => controller.setPersistedSettings(defaultSettings));
      let writing!: Promise<void>;
      await act(async () => {
        controller.updateSettings({ fontSize: 28, ttsSpeed: 1.5 });
        writing = controller.flush();
      });
      await act(async () => renderer.update(<Harness repository={second} />));
      const accountSettings = { ...defaultSettings, fontSize: 19 };
      await act(async () => controller.setPersistedSettings(accountSettings));
      const committedBefore = controller.persistedSettings;
      callbacks.onSaved.mockClear();
      await act(async () => {
        if (outcome === 'success') finish();
        else fail(new Error('old account save failed'));
        await writing;
      });
      expect(controller.persistedSettings).toEqual(committedBefore);
      expect(controller.settings).toEqual(accountSettings);
      expect(controller.saveError).toBe(false);
      expect(callbacks.onSaved).not.toHaveBeenCalled();
      expect(callbacks.onSaveError).not.toHaveBeenCalled();
      expect(second.saveSettings).not.toHaveBeenCalled();
    } finally {
      finish();
      await act(async () => renderer.unmount());
    }
  },
);
