import { expect, it } from 'vitest';
import { normalizeReaderSettings } from '@boaa/reader-core/settings';
import {
  sharedReaderSettings,
  sharedReaderSettingsEqual,
  deviceReaderSettings,
} from '@boaa/reader-core/settings-scope';
import { readerSettingsEqual } from '../../features/reader-settings/reader-settings-model';
import { defaultSettings } from '../../repositories/reader-defaults';
import type { HomeRowConfig } from './contract';

it('normalizes layout input, retaining explicit empty and distinguishing unset defaults', () => {
  const homeRows = [
    null,
    {},
    { id: 'x', kind: 'unknown', visible: true },
    { id: 'missing', kind: 'shelf', visible: true },
    { id: 'valid', kind: 'unread', visible: false, unexpected: true },
    { id: 'valid', kind: 'finished', visible: true },
    { id: 'shelf', kind: 'shelf', visible: true, shelfId: 's1' },
  ];
  expect(normalizeReaderSettings({ homeRows: homeRows as HomeRowConfig[] }).homeRows).toEqual([
    { id: 'valid', kind: 'unread', visible: false },
    { id: 'shelf', kind: 'shelf', visible: true, shelfId: 's1' },
  ]);
  expect(normalizeReaderSettings().homeRows).toBeUndefined();
  expect(normalizeReaderSettings({ homeRows: [] }).homeRows).toEqual([]);
  expect(normalizeReaderSettings({ startupScreen: { kind: 'home' } }).startupScreen).toEqual({ kind: 'home' });
});
it('syncs homeRows and observes order/visibility changes while startup stays device-local', () => {
  const rows: HomeRowConfig[] = [
    { id: 'first', kind: 'unread', visible: true },
    { id: 'second', kind: 'favorites', visible: false },
  ];
  const settings = { ...defaultSettings, homeRows: rows, startupScreen: { kind: 'home' as const } };
  const shared = sharedReaderSettings(settings);
  expect(shared.homeRows).toEqual(rows);
  expect(shared).not.toHaveProperty('startupScreen');
  expect(deviceReaderSettings(settings)).not.toHaveProperty('homeRows');
  expect(normalizeReaderSettings(shared).homeRows).toEqual(rows);
  expect(readerSettingsEqual(settings, { ...settings, homeRows: [...rows].reverse() })).toBe(false);
  expect(sharedReaderSettingsEqual(settings, { ...settings, homeRows: [{ ...rows[0], visible: false }] })).toBe(false);
  expect(readerSettingsEqual(settings, normalizeReaderSettings(settings))).toBe(true);
});
