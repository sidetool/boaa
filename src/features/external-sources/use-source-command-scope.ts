import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
export type SourceCommandScope = Pick<
  UseExternalSourceControllerOptions,
  'registry' | 'state' | 'settingsScope' | 'extensionRevision'
>;
/** Captures an owner and effect lifetime; a replaced owner cannot revive on A→B→A. */
export function useSourceCommandScope(input: SourceCommandScope) {
  const { registry, state, settingsScope, extensionRevision } = input;
  const owner = useMemo(
    () => ({ registry, state, settingsScope, extensionRevision, active: false, epoch: 0 }),
    [registry, state, settingsScope, extensionRevision],
  );
  const latest = useRef(owner);
  latest.current = owner;
  useLayoutEffect(() => {
    owner.active = true;
    owner.epoch++;
    return () => {
      owner.active = false;
      owner.epoch++;
    };
  }, [owner]);
  const capture = useCallback(() => {
    const epoch = owner.epoch;
    return () => owner.active && latest.current === owner && owner.epoch === epoch;
  }, [owner]);
  return { owner, capture };
}
