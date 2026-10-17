import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { useCallback, type SetStateAction } from 'react';

import { useNavigationViewState } from '../navigation/navigation-view-state';

export interface DiscoverySelection {
  selected?: string;
  quickSource?: string;
}
const storageKey = (scope: string) => `boaa.discovery-selection.v1:${scope}`;
/** Device-only destination, scoped like discovery settings. Queries and other transient controls are excluded. */
export function readDiscoverySelection(scope: string): DiscoverySelection {
  try {
    const value = JSON.parse(readBrandStorage(localStorage, storageKey(scope)) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return {
      selected: typeof value.selected === 'string' && value.selected.length <= 256 ? value.selected : undefined,
      quickSource:
        typeof value.quickSource === 'string' && value.quickSource.length <= 256 ? value.quickSource : undefined,
    };
  } catch {
    return {};
  }
}
export function saveDiscoverySelection(scope: string, patch: DiscoverySelection): void {
  try {
    writeBrandStorage(localStorage, storageKey(scope), JSON.stringify({ ...readDiscoverySelection(scope), ...patch }));
  } catch {
    /* In-memory navigation still works when device storage is unavailable. */
  }
}
/** Keeps the existing tab-local history precedence. Only explicit ui-next navigation writes the reload preference. */
export function useDiscoverySelection(scope: string, firstTab: string, sourceIds: readonly string[]) {
  const [selected, setSelectedState] = useNavigationViewState(
    `discovery-tab:${scope}`,
    () => readDiscoverySelection(scope).selected ?? firstTab,
  );
  const [savedQuickSource, setQuickSourceState] = useNavigationViewState<string | undefined>(
    `discovery-quick:${scope}`,
    () => readDiscoverySelection(scope).quickSource,
  );
  const setSelected = useCallback(
    (update: SetStateAction<string>) =>
      setSelectedState((previous) => {
        const next = typeof update === 'function' ? update(previous) : update;
        saveDiscoverySelection(scope, { selected: next });
        return next;
      }),
    [scope, setSelectedState],
  );
  const setQuickSource = useCallback(
    (update: SetStateAction<string | undefined>) =>
      setQuickSourceState((previous) => {
        const next = typeof update === 'function' ? update(previous) : update;
        saveDiscoverySelection(scope, { quickSource: next });
        return next;
      }),
    [scope, setQuickSourceState],
  );
  return {
    selected,
    setSelected,
    quickSource: sourceIds.includes(savedQuickSource ?? '') ? savedQuickSource : undefined,
    setQuickSource,
  };
}
