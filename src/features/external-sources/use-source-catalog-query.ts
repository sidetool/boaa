import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { ExternalSourceListInput } from '../../external-sources/contracts';
import { runSourceCatalogQuery, type SourceCatalogQueryPort, type SourceCatalogSeed } from './source-catalog-query';
import { initialSourceCatalogState, sourceCatalogSetters } from './source-catalog-state';

export type SourceCatalogQueryIntent = 'navigation' | 'command-refresh';

export interface SourceCatalogQueryInput extends SourceCatalogQueryPort {
  extensionRevision?: number;
  activeSourceId?: ExtensionContributionId;
  blocked: boolean;
}
/** Catalog requests have a shorter lifetime than downloads and stream-save queues. */
export function useSourceCatalogQuery(input: SourceCatalogQueryInput) {
  const [state, setState] = useState(initialSourceCatalogState);
  const setters = useMemo(() => sourceCatalogSetters(setState), []);
  const listAbortRef = useRef<AbortController>();
  const localSeriesPageSeedRef = useRef<SourceCatalogSeed>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const inputRef = useRef(input);
  inputRef.current = input;
  const { registry, state: storage, settingsScope, extensionRevision } = input;
  const scope = useMemo(
    () => ({ registry, storage, settingsScope, extensionRevision, active: false, epoch: 0 }),
    [registry, storage, settingsScope, extensionRevision],
  );
  const latestScope = useRef(scope);
  latestScope.current = scope;
  useLayoutEffect(() => {
    setState(initialSourceCatalogState);
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
      listAbortRef.current?.abort();
      localSeriesPageSeedRef.current = undefined;
    };
  }, [scope]);
  const isCurrentOwner = useCallback(() => scope.active && latestScope.current === scope, [scope]);
  const loadPage = useCallback(
    async (
      query: ExternalSourceListInput,
      append: boolean,
      sourceOverride?: ExtensionContributionId,
      notifyFailure = true,
      forceRefresh = false,
      intent: SourceCatalogQueryIntent = 'navigation',
    ): Promise<boolean | undefined> => {
      if (!scope.active || latestScope.current !== scope) return;
      const port = inputRef.current;
      const sourceId = sourceOverride ?? port.activeSourceId;
      if (!sourceId || (port.blocked && intent !== 'command-refresh')) return;
      listAbortRef.current?.abort();
      const abort = new AbortController();
      listAbortRef.current = abort;
      const epoch = scope.epoch;
      const ownsRequest = () =>
        scope.active && latestScope.current === scope && scope.epoch === epoch && listAbortRef.current === abort;
      const connection = port.registry.getExternalSourceStatus(sourceId, port.hostContext);
      const connectionIsCurrent = () => {
        if (!ownsRequest() || abort.signal.aborted) return false;
        const current = port.registry.getExternalSourceStatus(sourceId, inputRef.current.hostContext);
        return (
          current.state === 'connected' &&
          current.connectionGeneration === connection.connectionGeneration &&
          (current.accountConnectionId ?? '') === (connection.accountConnectionId ?? '')
        );
      };
      return runSourceCatalogQuery({
        port,
        sourceId,
        connection,
        input: query,
        append,
        notifyFailure,
        forceRefresh,
        abort,
        ownsRequest,
        connectionIsCurrent,
        seedRef: localSeriesPageSeedRef,
        state: stateRef.current,
        update: (action) => {
          if (ownsRequest()) setState(action);
        },
      });
    },
    [scope],
  );
  return { state, setters, loadPage, listAbortRef, localSeriesPageSeedRef, isCurrentOwner };
}
