import { useCallback, useEffect, useMemo, useRef } from 'react';

/** A task retains the exact effect lifetime, including StrictMode replays and A→B→A changes. */
export function usePdfTaskOwner(scope: string, repository: unknown, resource?: unknown) {
  const owner = useMemo(
    () => ({ active: false, epoch: 0, scope, repository, resource }),
    [scope, repository, resource],
  );
  const current = useRef(owner);
  current.current = owner;
  useEffect(() => {
    owner.active = true;
    owner.epoch += 1;
    return () => {
      owner.active = false;
      owner.epoch += 1;
    };
  }, [owner]);
  const capture = useCallback(() => {
    const epoch = owner.epoch;
    return () => current.current === owner && owner.active && owner.epoch === epoch;
  }, [owner]);
  return { owner, capture };
}
