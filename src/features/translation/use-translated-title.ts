import { useCallback, useSyncExternalStore } from 'react';
import { useTranslationClient } from './translation-client';

/** A display-only projection. Callers must keep the original identity and action payloads. */
export function useTranslatedTitle(original: string, visible = true): string {
  const client = useTranslationClient();
  const subscribe = useCallback(
    (changed: () => void) => {
      return visible && client ? client.titles.subscribe(original, changed) : () => undefined;
    },
    [client, original, visible],
  );
  const snapshot = useCallback(
    () => (visible ? (client?.titles.get(original) ?? original) : original),
    [client, original, visible],
  );
  return useSyncExternalStore(subscribe, snapshot, () => original);
}
