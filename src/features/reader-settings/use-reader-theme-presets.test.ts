import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadingProfile } from '../../domain/types';
import { useReaderThemePresets, type ReaderThemePresetsModel } from './use-reader-theme-presets';
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it('persists, confirms overwrites, validates rename and preserves state on storage failure', () => {
  const data = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => {
    data.set(key, value);
  });
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const updateProfile = vi.fn();
  let model!: ReaderThemePresetsModel;
  function Harness() {
    model = useReaderThemePresets({
      profile: { brightness: 80 } as ReadingProfile,
      foreground: '#112233',
      background: '#ffffff',
      updateProfile,
    });
    return null;
  }
  act(() => {
    renderer = create(createElement(Harness));
  });
  act(() => model.setName(' First '));
  act(() =>
    model.save(() => {
      throw new Error('must not confirm');
    }),
  );
  const first = model.presets[0];
  expect(first.name).toBe('First');
  act(() => model.apply(first.id));
  expect(updateProfile).toHaveBeenCalledWith({
    theme: 'custom',
    foreground: '#112233',
    background: '#ffffff',
    brightness: 80,
  });
  act(() => model.setName('First'));
  const confirm = vi.fn(() => false);
  act(() => model.save(confirm));
  expect(confirm).toHaveBeenCalledWith('First');
  expect(model.presets[0]).toBe(first);
  act(() => model.save(() => true));
  expect(model.presets).toHaveLength(1);
  act(() => model.beginRename(model.presets[0].id));
  act(() => model.setRenameDraft(' Renamed '));
  act(() => model.rename());
  expect(model.presets[0].name).toBe('Renamed');
  expect(model.editing).toBeUndefined();
  act(() => renderer.unmount());
  act(() => {
    renderer = create(createElement(Harness));
  });
  expect(model.presets[0].name).toBe('Renamed');
  setItem.mockImplementationOnce(() => {
    throw new Error('quota');
  });
  act(() => model.remove(model.presets[0].id));
  expect(model.error).toBe('save_failed');
  expect(model.presets).toHaveLength(1);
  act(() => model.remove(model.presets[0].id));
  expect(model.error).toBeUndefined();
  expect(model.presets).toEqual([]);
});
