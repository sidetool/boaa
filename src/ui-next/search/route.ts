import { useSyncExternalStore } from 'react';
import { navigateAppBack } from '../../features/navigation/browser-navigation';
import { randomUuid } from '../../utils/random-uuid';

export interface SearchRoute {
  id: string;
  initialQuery?: string;
}
let route: SearchRoute | undefined;
const listeners = new Set<() => void>();
export const getSearchRoute = () => route;
export function setSearchRoute(next: SearchRoute | undefined) {
  if (route === next) return;
  route = next;
  listeners.forEach((listener) => listener());
}
export function openSearch(initialQuery?: string) {
  setSearchRoute({ id: randomUuid(), initialQuery: initialQuery?.trim() || undefined });
}
export function closeSearch() {
  if (route) navigateAppBack(() => setSearchRoute(undefined));
}
export function useSearchRoute() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSearchRoute,
    () => undefined,
  );
}
