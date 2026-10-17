import { isUiJson, uiRecord, uiKeys, uiInteger, uiString, type UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore } from '../ui/store-model';
import { PLATFORM_STORE_LIMITS as limits } from './store-model';
export type SettingsField = {
  label?: string;
  description?: string;
} & (
  | { type: 'boolean'; default: boolean }
  | { type: 'number'; default: number; min?: number; max?: number }
  | { type: 'string'; default: string; maxLength?: number }
  | { type: 'color'; default: string }
  | { type: 'enum'; default: string; options: string[] }
  | { type: 'list'; default: UiJson[]; item: SettingsField; maxItems: number }
  | { type: 'group'; fields: Record<string, SettingsField> }
);
export interface SettingsSchema {
  version: number;
  fields: Record<string, SettingsField>;
}
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function fieldValue(field: SettingsField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= (field.min ?? -Infinity) &&
        value <= (field.max ?? Infinity)
      );
    case 'string':
      return typeof value === 'string' && value.length <= (field.maxLength ?? 4096);
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value);
    case 'enum':
      return typeof value === 'string' && field.options.includes(value);
    case 'list':
      return Array.isArray(value) && value.length <= field.maxItems && value.every((v) => fieldValue(field.item, v));
    case 'group':
      return fieldsValue(field.fields, value);
  }
}
function fieldsValue(fields: Record<string, SettingsField>, value: unknown): boolean {
  return (
    uiRecord(value) &&
    Object.keys(fields).length === Object.keys(value).length &&
    Object.entries(fields).every(([key, field]) => own(value, key) && fieldValue(field, value[key]))
  );
}
/** Host schema checks are bounded data validation, never eval, regex supplied by plugins, or callbacks. */
export function validateSettingsSchema(value: unknown): asserts value is SettingsSchema {
  requireStore(
    isUiJson(value, limits.schemaBytes) &&
      uiRecord(value) &&
      uiKeys(value, ['version', 'fields']) &&
      uiInteger(value.version, 1, Number.MAX_SAFE_INTEGER),
    'INVALID_CONFIG_SCHEMA',
  );
  let count = 0;
  const fields = (v: unknown, depth: number): boolean =>
    uiRecord(v) &&
    Object.entries(v).every(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) && field(item, depth));
  const field = (v: unknown, depth: number): boolean => {
    if (++count > 128 || depth > 6 || !uiRecord(v)) return false;
    if (
      (v.label !== undefined && !uiString(v.label, 128)) ||
      (v.description !== undefined && !uiString(v.description, 1024))
    )
      return false;
    const meta = ['label', 'description'];
    if (v.type === 'group') return uiKeys(v, ['type', 'fields'], meta) && fields(v.fields, depth + 1);
    const optional: Record<string, string[]> = {
      boolean: [],
      number: ['min', 'max'],
      string: ['maxLength'],
      color: [],
      enum: ['options'],
      list: ['item', 'maxItems'],
    };
    if (
      typeof v.type !== 'string' ||
      !own(optional, v.type) ||
      !uiKeys(v, ['type', 'default'], [...meta, ...optional[v.type]])
    )
      return false;
    if (
      v.type === 'number' &&
      ((v.min !== undefined && typeof v.min !== 'number') ||
        (v.max !== undefined && typeof v.max !== 'number') ||
        (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max))
    )
      return false;
    if (v.type === 'string' && v.maxLength !== undefined && !uiInteger(v.maxLength, 0, 4096)) return false;
    if (
      v.type === 'enum' &&
      (!Array.isArray(v.options) ||
        !v.options.length ||
        v.options.length > 64 ||
        new Set(v.options).size !== v.options.length ||
        !v.options.every((s) => uiString(s, 256)))
    )
      return false;
    if (v.type === 'list' && (!uiInteger(v.maxItems, 0, 128) || !field(v.item, depth + 1))) return false;
    return fieldValue(v as SettingsField, v.default);
  };
  requireStore(fields(value.fields, 0), 'INVALID_CONFIG_SCHEMA');
}
export function settingsDefaults(schema: SettingsSchema): Record<string, UiJson> {
  validateSettingsSchema(schema);
  const defaults = (fields: Record<string, SettingsField>): Record<string, UiJson> =>
    Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        field.type === 'group' ? defaults(field.fields) : structuredClone(field.default),
      ]),
    );
  return defaults(schema.fields);
}
export function validateSettingsValue(schema: SettingsSchema, value: unknown): asserts value is Record<string, UiJson> {
  validateSettingsSchema(schema);
  requireStore(isUiJson(value, limits.configBytes) && fieldsValue(schema.fields, value), 'INVALID_CONFIG');
}
