import { useEffect, useRef } from 'react';

/** Dispatched on the host window by the plugin view runtime after it authorizes `ctx.app.search`. */
export const PLUGIN_SEARCH_EVENT = 'boaa:plugin-search';

export function pluginSearchQuery(event: Event): string | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  const query =
    detail && typeof detail === 'object' && typeof (detail as { query?: unknown }).query === 'string'
      ? (detail as { query: string }).query.trim()
      : '';
  return query && query.length <= 256 ? query : undefined;
}

/** Calls `handle` with each authorized plugin title search. */
export function usePluginSearchRequests(handle: (query: string) => void) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (event: Event) => {
      const query = pluginSearchQuery(event);
      if (!query) return;
      // Next task: the guest's reply settles before handling closes the frame that awaited it.
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(query), 0);
    };
    window.addEventListener(PLUGIN_SEARCH_EVENT, listener);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(PLUGIN_SEARCH_EVENT, listener);
    };
  }, []);
}
