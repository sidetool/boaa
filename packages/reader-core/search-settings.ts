export const MAX_RECENT_SEARCHES = 8;
export const MAX_SEARCH_QUERY_LENGTH = 200;

export function normalizeRecentSearches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const query = entry.trim();
    const key = query.normalize('NFKC').toLowerCase();
    if (!query || query.length > MAX_SEARCH_QUERY_LENGTH || seen.has(key) || seen.size >= MAX_RECENT_SEARCHES)
      return [];
    seen.add(key);
    return [query];
  });
}
