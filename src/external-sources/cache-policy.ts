import { sourceReadingPreferences } from './source-reading-preferences';
import type { ExternalItemPage, ExternalSourceListInput } from './contracts';
const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
export const COVER_FRESH_MS = 30 * day;
export const COVER_KEEP_MS = 365 * day;
export const DETAIL_FRESH_MS = 6 * hour;
function defaultSourceCachePolicy(input: ExternalSourceListInput, workMetadata = false) {
  if (workMetadata) return { fresh: 6 * hour, keep: 7 * day };
  if (input.accountConnectionId && !input.browseMode) {
    if (input.parentRef) return { fresh: 2 * minute, keep: 7 * day };
    if (input.query) return { fresh: 10 * minute, keep: 6 * hour };
  }
  if (input.query || input.filters?.length || input.browseMode === 'search' || input.browseMode === 'popular')
    return { fresh: 6 * hour, keep: 7 * day };
  if (input.browseMode === 'latest') return { fresh: 5 * minute, keep: 2 * day };
  if (input.parentRef) return { fresh: 15 * minute, keep: 7 * day };
  return { fresh: 30 * minute, keep: day };
}
export function sourceCachePolicy(input: ExternalSourceListInput, workMetadata = false, scope?: string) {
  const policy = defaultSourceCachePolicy(input, workMetadata);
  const value = input.cacheMaxAgeMs ?? sourceReadingPreferences(scope).listMinutes * minute;
  const max =
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 6 * hour) : policy.fresh;
  return { ...policy, fresh: Math.min(policy.fresh, max) };
}
/** A new work should become discoverable soon after an empty search or listing. */
export function sourcePageFreshness(fresh: number, itemCount: number) {
  return itemCount ? fresh : Math.min(fresh, minute);
}
export function sourcePageTime(page: ExternalItemPage, fallback = Date.now()) {
  const time = page.cache?.fetchedAt;
  return typeof time === 'number' && Number.isFinite(time) && time > 0 ? Math.min(time, fallback) : fallback;
}
export function transientSourceFailure(error: unknown) {
  let value = error as
    { status?: number; statusCode?: number; code?: string; message?: string; cause?: unknown } | undefined;
  let transient = false;
  for (let depth = 0; value && depth < 3; depth++) {
    const status = value.status ?? value.statusCode ?? 0;
    const message = `${value.code ?? ''} ${value.message ?? ''}`;
    if (
      [401, 403, 404, 410].includes(status) ||
      /access_(?:denied|required)|auth(?:entication)?_|verification_required|not_configured|invalid_|origin_rejected|generation_changed|catalog_changed|work_unavailable|content_unavailable|not_found|HTTP (?:401|403|404|410)/i.test(
        message,
      )
    )
      return false;
    transient ||=
      [429, 500, 502, 503, 504].includes(status) ||
      /timeout|timed out|network|offline|fetch failed|failed to fetch|connection_failed|ECONN|ENET|EAI_AGAIN|execution_busy|worker_busy|HTTP (?:429|50[0234])|gateway|연결.*실패|시간.*초과/i.test(
        message,
      );
    value = value.cause as typeof value;
  }
  return transient;
}
/** Hosts keep cache mode out of the extension guest's input and out of cache identity. */
export function sourceListIdentity(input: ExternalSourceListInput) {
  const { cacheMode: _mode, cacheMaxAgeMs: _age, ...identity } = input;
  return identity;
}
