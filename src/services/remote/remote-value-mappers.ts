import type { JsonValue } from '@boaa/contracts/sync';
export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optionalNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function sanitizedJobProgressValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) return value.map(sanitizedJobProgressValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'providerOptions')
        .map(([key, item]) => [key, sanitizedJobProgressValue(item)]),
    );
  }
  return null;
}
