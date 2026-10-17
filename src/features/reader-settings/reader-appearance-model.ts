import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import { normalizeApplicationThemeColors } from './app-theme';
import { resolveReaderThemeColors } from './reader-theme-colors';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { ReadingPreset } from './reader-settings-model';

export interface ReaderAppearanceModelInput {
  controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  profile: ReadingProfile;
  updateProfile(patch: ReadingProfileOverride): void;
  themeTarget: 'application' | 'reader';
}
export const READER_THEME_OPTIONS = ['midnight', 'dark', 'light', 'sepia', 'custom'] as const;
export const READER_FONT_OPTIONS = ['builtin-serif', 'builtin-sans', 'builtin-mono'] as const;
export function createReaderAppearanceModel({
  controller,
  profile,
  updateProfile,
  themeTarget,
}: ReaderAppearanceModelInput) {
  const appTheme = controller.settings.applicationTheme ?? 'dark';
  const appColors = normalizeApplicationThemeColors(controller.settings.applicationThemeColors);
  const readerColors = resolveReaderThemeColors(profile);
  const activeTheme = themeTarget === 'application' ? appTheme : profile.theme;
  const selectTheme = (theme: ReadingProfile['theme']) => {
    if (themeTarget === 'application') {
      controller.updateSettings({ applicationTheme: theme });
      return;
    }
    updateProfile({ theme });
  };

  const setAppColor = (field: keyof typeof appColors, value: string) =>
    controller.updateSettings({
      applicationTheme: 'custom',
      applicationThemeColors: { ...appColors, [field]: value },
    });
  const applyPreset = (settings: ReadingPreset['settings']) =>
    updateProfile({
      fontId: settings.font === 'sans' ? 'builtin-sans' : settings.font === 'mono' ? 'builtin-mono' : 'builtin-serif',
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      paragraphSpacing: settings.paragraphSpacing,
      marginX: settings.marginX,
      marginY: settings.marginY,
      contentWidth: settings.contentWidth,
    });
  return {
    appTheme,
    appColors,
    readerColors,
    activeTheme,
    selectTheme,
    setAppColor,
    applyPreset,
    themeOptions: READER_THEME_OPTIONS,
    fontOptions: READER_FONT_OPTIONS,
    profile,
    updateProfile,
    settings: controller.settings,
    updateSettings: controller.updateSettings,
  };
}
export type ReaderAppearanceModel = ReturnType<typeof createReaderAppearanceModel>;
