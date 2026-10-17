import { useCallback, useEffect, useRef, useState } from 'react';

export interface StorageEstimateView {
  readonly usage?: number;
  readonly quota?: number;
  readonly loading: boolean;
  readonly unavailable: boolean;
}

export function useDeviceStorageEstimate() {
  const [estimate, setEstimate] = useState<StorageEstimateView>({ loading: true, unavailable: false });
  const generation = useRef({ value: 0 }).current;
  const refresh = useCallback(async () => {
    const request = ++generation.value;
    const read = globalThis.navigator?.storage?.estimate;
    if (!read) {
      setEstimate({ loading: false, unavailable: true });
      return;
    }
    setEstimate((current) => ({ ...current, loading: true }));
    try {
      const next = await read.call(globalThis.navigator.storage);
      if (request !== generation.value) return;
      setEstimate({ usage: next.usage, quota: next.quota, loading: false, unavailable: false });
    } catch {
      if (request !== generation.value) return;
      setEstimate({ loading: false, unavailable: true });
    }
  }, [generation]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.value++;
    };
  }, [refresh, generation]);
  const ratio =
    estimate.usage !== undefined && estimate.quota
      ? Math.min(100, Math.max(0, (estimate.usage / estimate.quota) * 100))
      : undefined;
  return { ...estimate, ratio, refresh };
}
export type DeviceStorageEstimateModel = ReturnType<typeof useDeviceStorageEstimate>;
