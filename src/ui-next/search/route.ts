import { useSyncExternalStore } from 'react';
import { navigateAppBack } from '../../features/navigation/browser-navigation';
import { clearNavigationViewState } from '../../features/navigation/navigation-view-state';
import { randomUuid } from '../../utils/random-uuid';

export interface SearchRoute {
  id: string;
  initialQuery?: string;
}
let route: SearchRoute | undefined;
let resultOriginId: string | undefined;
const listeners = new Set<() => void>();
export const getSearchRoute = () => route;
export function setSearchRoute(next: SearchRoute | undefined) {
  if (route === next) return;
  if (next) resultOriginId = undefined;
  route = next;
  listeners.forEach((listener) => listener());
}
/** All presentation snapshots and the active search belong to the ending account session. */
export function clearSessionNavigation() {
  resultOriginId = undefined;
  clearNavigationViewState();
  setSearchRoute(undefined);
}
/** A result may need an async lookup before the workspace changes. Keep this history entry for Back. */
export function leaveSearchForResult() {
  resultOriginId = route?.id;
  setSearchRoute(undefined);
}
export function isSearchResultTransition(origin?: SearchRoute) {
  return Boolean(origin && origin.id === resultOriginId);
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
