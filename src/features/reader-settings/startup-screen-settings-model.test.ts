import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { createStartupScreenSettingsModel } from './startup-screen-settings-model';
it('preserves unavailable destinations until an explicit valid selection, excluding hidden tabs', () => {
  const updateSettings = vi.fn();
  const settings = { ...defaultSettings, startupScreen: { kind: 'library' as const, shelfId: 'gone' } };
  const model = createStartupScreenSettingsModel({
    controller: { settings, updateSettings },
    tabs: [
      { id: 'visible', title: 'Visible' },
      { id: 'hidden', title: 'Hidden', hidden: true },
    ],
  });
  expect(model.value).toBe('shelf:gone');
  expect(model.missing).toBe(true);
  expect(model.options.map((option) => option.value)).toEqual(['last', 'home', 'library', 'discovery', 'tab:visible']);
  model.select('tab:hidden');
  expect(updateSettings).not.toHaveBeenCalled();
  model.select('tab:visible');
  expect(updateSettings.mock.lastCall![0](settings).startupScreen).toEqual({ kind: 'discovery', tabId: 'visible' });
  model.select('last');
  expect(updateSettings.mock.lastCall![0](settings).startupScreen).toBeUndefined();
});
