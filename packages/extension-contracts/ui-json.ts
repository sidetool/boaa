/** Values crossing the UI bridge are JSON data, never app objects or callable references. */
export type UiJson = null | boolean | number | string | UiJson[] | { [key: string]: UiJson };
export const UI_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 256 * 1024,
  selectionBytes: 16 * 1024,
  valueBytes: 64 * 1024,
  storageBytes: 1024 * 1024,
  storageEntries: 1000,
  depth: 20,
  nodes: 10000,
});
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function uiRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function uiKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
export function uiString(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
export function uiInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
export function uiId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
export function uiUtf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}
/** Bounded traversal precedes stringify; getters/toJSON are never invoked. Not a pre-clone heap quota. */
export function isUiJson(value: unknown, maximumBytes: number): value is UiJson {
  let nodes = 0;
  let lowerBoundBytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > UI_LIMITS.nodes || depth > UI_LIMITS.depth) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') {
      if (item.length > maximumBytes) return false;
      lowerBoundBytes += uiUtf8Size(item);
      return lowerBoundBytes <= maximumBytes;
    }
    if (typeof item !== 'object' || seen.has(item)) return false;
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const names = Object.keys(descriptors);
    if (names.length > UI_LIMITS.nodes) return false;
    if (array && (item.length > UI_LIMITS.nodes || names.length !== item.length + 1)) return false;
    for (const name of names) {
      if (array && name === 'length') continue;
      if (forbidden.has(name) || (array && !/^(0|[1-9]\d*)$/.test(name))) return false;
      lowerBoundBytes += uiUtf8Size(name);
      const descriptor = descriptors[name];
      if (
        lowerBoundBytes > maximumBytes ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        !visit(descriptor.value, depth + 1)
      )
        return false;
    }
    seen.delete(item);
    return true;
  }
  try {
    return visit(value, 0) && uiUtf8Size(JSON.stringify(value)) <= maximumBytes;
  } catch {
    return false;
  }
}
