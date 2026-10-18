import { readBrandStorage } from '@boaa/extension-contracts/brand-compat';
/** Device-only reading metadata. No source URL, credential, or image payload is stored. */
export interface SourceStreamPosition {
  page: number;
  count: number;
  fraction: number;
  ratio: number;
  updatedAt: number;
}
const key = 'boaa.source-stream-positions.v1';
const maxAge = 180 * 86400000;
function storageKey(identity: string): string {
  try {
    const base = identity.split(':text:')[0];
    const scope = JSON.parse(base)?.[0];
    if (typeof scope === 'string' && scope.startsWith('hosted-account:')) return `${key}:${scope}`;
  } catch {
    /* Legacy/local identity. */
  }
  return key;
}
function entries(storage = key): [string, SourceStreamPosition][] {
  try {
    const value: unknown = JSON.parse(
      (storage === key ? readBrandStorage(localStorage, key) : localStorage.getItem(storage)) ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is [string, SourceStreamPosition] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1]) return false;
        const p = entry[1];
        return (
          Number.isSafeInteger(p.page) &&
          p.page >= 0 &&
          Number.isSafeInteger(p.count) &&
          p.page < p.count &&
          Number.isFinite(p.fraction) &&
          p.fraction >= 0 &&
          p.fraction < 1 &&
          Number.isFinite(p.ratio) &&
          p.ratio > 0 &&
          p.ratio < 10000 &&
          Number.isFinite(p.updatedAt) &&
          p.updatedAt > Date.now() - maxAge
        );
      })
      .slice(-200);
  } catch {
    return [];
  }
}
export function readSourceStreamPosition(identity: string): SourceStreamPosition | undefined {
  return entries(storageKey(identity)).find(([id]) => id === identity)?.[1];
}
export function saveSourceStreamPosition(identity: string, position: Omit<SourceStreamPosition, 'updatedAt'>): void {
  try {
    const storage = storageKey(identity);
    const next = entries(storage).filter(([id]) => id !== identity);
    next.push([identity, { ...position, updatedAt: Date.now() }]);
    localStorage.setItem(storage, JSON.stringify(next.slice(-200)));
  } catch {
    /* Reading remains available with browser storage disabled or full. */
  }
}

/** Remove both image offsets and every text-revision offset for the selected episodes. */
export function clearSourceStreamPositions(identities: readonly string[], cutoff = Infinity): void {
  const grouped = new Map<string, string[]>();
  for (const identity of identities) {
    const storage = storageKey(identity);
    grouped.set(storage, [...(grouped.get(storage) ?? []), identity]);
  }
  for (const [storage, values] of grouped) clearGroup(storage, values, cutoff);
}
function clearGroup(storage: string, identities: readonly string[], cutoff: number) {
  const selected = new Set(identities);
  const before = entries(storage);
  const remaining = before.filter(([id, position]) => {
    if (position.updatedAt > cutoff) return true;
    if (selected.has(id)) return false;
    const textSuffix = id.lastIndexOf(':text:');
    return textSuffix < 0 || !selected.has(id.slice(0, textSuffix));
  });
  if (remaining.length === before.length) return;
  localStorage.setItem(storage, JSON.stringify(remaining));
}
