import { isUiJson, uiInteger, uiKeys, uiRecord, uiString } from './ui-json';

export interface HomeFeedSection {
  id: string;
  title: string;
  description?: string;
  /** Declared plugin view opened by the host row action. */
  view?: string;
}
export interface HomeFeedItem {
  id: string;
  title: string;
  author?: string;
  rank?: number;
  coverUrl?: string;
  /** Defaults to the displayed title. The host opens its existing unified search. */
  searchQuery?: string;
}
export interface HomeFeed {
  items: HomeFeedItem[];
  asOf?: string;
  ttlSeconds?: number;
}
export function homeFeedSections(value: unknown): value is HomeFeedSection[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (s) =>
        uiRecord(s) &&
        uiKeys(s, ['id', 'title'], ['description', 'view']) &&
        typeof s.id === 'string' &&
        /^[a-z][a-z0-9.-]{0,63}$/.test(s.id) &&
        uiString(s.title, 128) &&
        (s.view === undefined || (typeof s.view === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(s.view))) &&
        (s.description === undefined || uiString(s.description, 256)),
    ) &&
    new Set(value.map((s) => s.id)).size === value.length
  );
}
export function publicImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}
export function validateHomeFeed(value: unknown): HomeFeed {
  if (
    !isUiJson(value, 48 * 1024) ||
    !uiRecord(value) ||
    !uiKeys(value, ['items'], ['asOf', 'ttlSeconds']) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.asOf !== undefined &&
      (typeof value.asOf !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(value.asOf) ||
        !Number.isFinite(Date.parse(value.asOf)))) ||
    (value.ttlSeconds !== undefined && !uiInteger(value.ttlSeconds, 60, 86400))
  )
    throw Error('INVALID_HOME_FEED');
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !uiRecord(item) ||
      !uiKeys(item, ['id', 'title'], ['author', 'rank', 'coverUrl', 'searchQuery']) ||
      !uiString(item.id, 128) ||
      seen.has(item.id) ||
      !uiString(item.title, 256) ||
      (item.author !== undefined && !uiString(item.author, 256)) ||
      (item.rank !== undefined && !uiInteger(item.rank, 1, 100000)) ||
      (item.searchQuery !== undefined && !uiString(item.searchQuery, 256)) ||
      (item.coverUrl !== undefined && !publicImageUrl(item.coverUrl))
    )
      throw Error('INVALID_HOME_FEED');
    seen.add(item.id);
  }
  return value as unknown as HomeFeed;
}
