import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SettingsTabContent, type SettingsTabContentProps } from './SettingsTabContent';
vi.mock('./StartupScreenSettings', () => ({ StartupScreenSettings: () => <span>startup</span> }));
vi.mock('./ReaderSettingsAppearance', () => ({
  ReaderSettingsAppearance: ({ themeTarget }: { themeTarget: string }) => <span>{themeTarget}</span>,
}));
it('keeps startup settings without the retired application theme chooser', () => {
  const props = { tab: 'appearance' } as SettingsTabContentProps;
  const hidden = renderToStaticMarkup(<SettingsTabContent {...props} />);
  expect(hidden).not.toContain('application');
  expect(hidden).toContain('startup');
});
vi.mock('./ReaderSettingsLayout', () => ({ ReaderSettingsLayout: () => null }));
it('retains reader theme controls', () => {
  const props = { tab: 'layout' } as SettingsTabContentProps;
  expect(renderToStaticMarkup(<SettingsTabContent {...props} />)).toContain('reader');
});
