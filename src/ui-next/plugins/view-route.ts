import { useSyncExternalStore } from 'react';
import { randomUuid } from '../../utils/random-uuid';

/** A declared plugin view opened outside settings, e.g. from a home row action. */
export interface PluginViewRoute {
  key: string;
  pluginId: string;
  view: string;
  title?: string;
}
let route: PluginViewRoute | undefined;
const listeners = new Set<() => void>();
export const getPluginViewRoute = () => route;
function setRoute(next: PluginViewRoute | undefined) {
  if (route === next) return;
  route = next;
  listeners.forEach((listener) => listener());
}
export function openPluginView(pluginId: string, view: string, title?: string) {
  setRoute({ key: randomUuid(), pluginId, view, title });
}
export function closePluginView() {
  setRoute(undefined);
}
export function usePluginViewRoute() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPluginViewRoute,
    () => undefined,
  );
}
