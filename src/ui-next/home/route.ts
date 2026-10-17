import { useSyncExternalStore } from 'react';

/** Session-only destination, captured by the existing app history alongside library filters. */
let active = false;
const listeners = new Set<() => void>();
export const getHomeActive = () => active;
export function setHomeActive(next: boolean) {
  if (active === next) return;
  active = next;
  listeners.forEach((listener) => listener());
}
export function useHomeActive() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getHomeActive,
    () => false,
  );
}
