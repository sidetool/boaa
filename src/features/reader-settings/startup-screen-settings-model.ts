import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { ReaderSettings } from '../../domain/types';

export interface StartupScreenSettingsModelInput {
  controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  shelves?: readonly { id: string; name: string }[];
  tabs?: readonly { id: string; title: string; hidden?: boolean }[];
}
export interface StartupScreenOption {
  value: string;
  kind: 'default' | 'home' | 'library' | 'shelf' | 'discovery' | 'tab';
  name?: string;
  preference: ReaderSettings['startupScreen'];
}
export function createStartupScreenSettingsModel({
  controller,
  shelves = [],
  tabs = [],
}: StartupScreenSettingsModelInput) {
  const preference = controller.settings.startupScreen;
  const options: StartupScreenOption[] = [
    { value: 'last', kind: 'default', preference: undefined },
    { value: 'home', kind: 'home', preference: { kind: 'home' } },
    { value: 'library', kind: 'library', preference: { kind: 'library' } },
    ...shelves.map((shelf) => ({
      value: `shelf:${shelf.id}`,
      kind: 'shelf' as const,
      name: shelf.name,
      preference: { kind: 'library' as const, shelfId: shelf.id },
    })),
    { value: 'discovery', kind: 'discovery', preference: { kind: 'discovery' } },
    ...tabs
      .filter((tab) => !tab.hidden)
      .map((tab) => ({
        value: `tab:${tab.id}`,
        kind: 'tab' as const,
        name: tab.title,
        preference: { kind: 'discovery' as const, tabId: tab.id },
      })),
  ];
  const value =
    preference?.kind === 'home'
      ? 'home'
      : preference?.kind === 'library'
        ? preference.shelfId
          ? `shelf:${preference.shelfId}`
          : 'library'
        : preference?.kind === 'discovery'
          ? preference.tabId
            ? `tab:${preference.tabId}`
            : 'discovery'
          : 'last';
  const select = (value: string) => {
    const next = options.find((option) => option.value === value);
    if (next) controller.updateSettings((previous) => ({ ...previous, startupScreen: next.preference }));
  };
  return { options, value, missing: !options.some((option) => option.value === value), select };
}
export type StartupScreenSettingsModel = ReturnType<typeof createStartupScreenSettingsModel>;
