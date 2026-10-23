import { useOptionalAppRuntime } from '../app/runtime/RuntimeProvider';
import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { useSyncExternalStore } from 'react';

import { isWorkView, type WorkView } from './work-view-model';
export { isWorkView, isCoverView, workViews, type WorkView } from './work-view-model';

const memory = new Map<string, WorkView>();
const eventName = 'boaa-work-view';
export function readWorkView(key: string, fallback: WorkView = 'grid'): WorkView {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const value = readBrandStorage(localStorage, key);
    return isWorkView(value) ? value : fallback;
  } catch {
    return memory.get(key) ?? fallback;
  }
}
export function saveWorkView(key: string, value: WorkView) {
  try {
    writeBrandStorage(localStorage, key, value);
    memory.delete(key);
  } catch {
    // Keep the current session usable when device storage is unavailable.
    memory.set(key, value);
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(eventName));
}
function subscribe(changed: () => void) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  window.addEventListener(eventName, changed);
  window.addEventListener('storage', changed);
  return () => {
    window.removeEventListener(eventName, changed);
    window.removeEventListener('storage', changed);
  };
}
export function useWorkView(key: string, fallback: WorkView = 'grid') {
  const scope = useOptionalAppRuntime()?.readerRuntime.session?.storageScope;
  const ownedKey = scope ? `${key}:${scope}` : key;
  const value = useSyncExternalStore(
    subscribe,
    () => readWorkView(ownedKey, fallback),
    () => fallback,
  );
  return [value, (next: WorkView) => saveWorkView(ownedKey, next)] as const;
}
