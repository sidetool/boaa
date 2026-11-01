import { useEffect, useState } from 'react';
import type { ExternalSourceLocalState, ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';

type Owner = { state: ExternalSourceLocalState; settingsScope?: string };
type Snapshot = Owner & {
  subscriptions: readonly ExternalSourceSubscriptionRecord[];
  preferences: readonly SourceReleasePreference[];
};

/** Display-only startup cache. Never reconciles, recovers, or writes shared state.
 * Linked downloads need the authoritative catalog (including trash), so only
 * standalone streaming works can be previewed before that catalog arrives.
 */
export function useCachedSourceLibrary({ state, settingsScope }: Owner, ready: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  useEffect(() => {
    if (ready) {
      setSnapshot(undefined);
      return;
    }
    let active = true;
    void (async () => {
      const [subscriptions, preferences] = await Promise.all([
        state.listSubscriptions(),
        state.listReleasePreferences?.() ?? Promise.resolve([]),
      ]);
      const links = await state.listLinks();
      if (!active) return;
      setSnapshot({
        state,
        settingsScope,
        preferences,
        subscriptions: subscriptions.filter(
          (work) =>
            !work.deletedAt &&
            !links.some(
              (link) =>
                link.source.connectorId === work.connectorId &&
                (link.source.accountConnectionId ?? '') === (work.accountConnectionId ?? '') &&
                link.collectionRemoteId === work.collectionRemoteId,
            ),
        ),
      });
    })().catch(() => undefined); // Authoritative bootstrap owns failures/retry.
    return () => {
      active = false;
    };
  }, [state, settingsScope, ready]);
  return !ready && snapshot?.state === state && snapshot.settingsScope === settingsScope ? snapshot : undefined;
}
