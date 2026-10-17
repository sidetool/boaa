import { expect, it } from 'vitest';
import {
  settingsDefaults,
  validateSettingsSchema,
  validateSettingsValue,
  type SettingsSchema,
} from './settings-schema';
const schema: SettingsSchema = {
  version: 1,
  fields: {
    enabled: { type: 'boolean', default: true },
    speed: { type: 'number', default: 2, min: 1, max: 4 },
    phrase: { type: 'string', default: '', maxLength: 20 },
    theme: { type: 'enum', default: 'dark', options: ['light', 'dark'] },
    colors: { type: 'list', default: ['#123456'], maxItems: 3, item: { type: 'color', default: '#000000' } },
    extra: { type: 'group', fields: { visible: { type: 'boolean', default: false } } },
  },
};
it('supports author-defined scalar, enum, list and grouped defaults without running code', () => {
  const defaults = settingsDefaults(schema);
  expect(defaults).toEqual({
    enabled: true,
    speed: 2,
    phrase: '',
    theme: 'dark',
    colors: ['#123456'],
    extra: { visible: false },
  });
  expect(() => validateSettingsValue(schema, defaults)).not.toThrow();
  (defaults.colors as string[]).push('#aaaaaa');
  expect(settingsDefaults(schema).colors).toEqual(['#123456']);
});
it.each([
  { speed: Infinity },
  { speed: 7 },
  { enabled: 1 },
  { theme: 'system' },
  { colors: ['url(javascript:alert(1))'] },
  { colors: ['#000000', '#000000', '#000000', '#000000'] },
  { extra: { visible: false, hidden: true } },
  { phrase: 'x'.repeat(21) },
  { missing: false },
])('rejects out-of-schema values %j', (patch) => {
  expect(() => validateSettingsValue(schema, { ...settingsDefaults(schema), ...patch })).toThrow('INVALID_CONFIG');
});
it.each([
  { type: 'enum', options: ['a', 'a'], default: 'a' },
  { type: 'number', min: 5, max: 1, default: 3 },
  { type: 'boolean', default: 'yes' },
  { type: 'string', default: '', validate: 'return true' },
  { type: 'list', default: [], item: { type: 'boolean', default: true }, maxItems: 1000 },
  { type: 'group', fields: JSON.parse('{"constructor":{"type":"boolean","default":true}}') },
])('rejects unsafe or invalid descriptor %j', (field) => {
  expect(() => validateSettingsSchema({ version: 1, fields: { example: field } })).toThrow('INVALID_CONFIG_SCHEMA');
});
it('rejects accessors without invoking them and bounds depth/field count', () => {
  let calls = 0;
  expect(() =>
    validateSettingsSchema({
      version: 1,
      get fields() {
        calls++;
        return {};
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
  expect(() =>
    validateSettingsSchema({
      version: 1,
      fields: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`a${i}`, { type: 'boolean', default: false }])),
    }),
  ).toThrow();
  let nested: unknown = { type: 'boolean', default: false };
  for (let i = 0; i < 8; i++) nested = { type: 'group', fields: { child: nested } };
  expect(() => validateSettingsSchema({ version: 1, fields: { root: nested } })).toThrow();
});
