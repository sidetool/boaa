import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { createReaderAppearanceModel } from './reader-appearance-model';
import { readingPresets } from './reader-settings-model';
it('routes app and reader theme changes to their respective stores and preserves other custom colors', () => {
  const updateSettings = vi.fn(),
    updateProfile = vi.fn();
  const input = {
    controller: { settings: defaultSettings, updateSettings },
    profile: defaultSettings.readingProfile,
    updateProfile,
  };
  const app = createReaderAppearanceModel({ ...input, themeTarget: 'application' });
  app.selectTheme('light');
  expect(updateSettings).toHaveBeenLastCalledWith({ applicationTheme: 'light' });
  expect(updateProfile).not.toHaveBeenCalled();
  app.setAppColor('text', '#123456');
  expect(updateSettings).toHaveBeenLastCalledWith({
    applicationTheme: 'custom',
    applicationThemeColors: { ...app.appColors, text: '#123456' },
  });
  const reader = createReaderAppearanceModel({ ...input, themeTarget: 'reader' });
  reader.selectTheme('sepia');
  expect(updateProfile).toHaveBeenLastCalledWith({ theme: 'sepia' });
  reader.applyPreset(readingPresets[0].settings);
  expect(updateProfile.mock.lastCall![0]).toMatchObject({
    fontId: 'builtin-serif',
    fontSize: readingPresets[0].settings.fontSize,
  });
});
