import { afterEach, expect, it, vi } from 'vitest';
import { uiNextAppClass, uiNextKitClass, usesAppHistory } from './app-presentation';

afterEach(() => vi.unstubAllGlobals());

it('uses the default chrome without consulting location or stored UI preferences', () => {
  const read = vi.fn(() => {
    throw new Error('browser preference must not be read');
  });
  vi.stubGlobal('window', {
    get location() {
      return read();
    },
    get localStorage() {
      return read();
    },
  });
  expect(uiNextAppClass('library')).toBe('app-shell ui-next');
  expect(uiNextAppClass('chapters')).toBe('app-shell ui-next');
  expect(uiNextAppClass('reader')).toBe('app-shell');
  expect(uiNextAppClass('document')).toBe('app-shell');
  expect(uiNextKitClass('dialog')).toBe('dialog un-kit');
  expect(read).not.toHaveBeenCalled();
});

it('preserves browser and mobile history without enabling desktop history', () => {
  expect(usesAppHistory('browser')).toBe(true);
  expect(usesAppHistory('tauri-mobile')).toBe(true);
  expect(usesAppHistory('tauri-desktop')).toBe(false);
});
