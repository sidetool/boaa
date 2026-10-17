import { useEffect, useRef, useState } from 'react';

interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

interface OrientationLike {
  lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
  unlock?: () => void;
}

/** Keep-awake and orientation lock for reading. Both are released when the owner unmounts. */
export function useReaderDeviceControls() {
  const sentinelRef = useRef<WakeLockSentinelLike>();
  const [wakeLocked, setWakeLocked] = useState(false);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>();
  const wakeLockAvailable = Boolean((navigator as Navigator & { wakeLock?: unknown }).wakeLock);
  const orientationApi = screen.orientation as ScreenOrientation & OrientationLike;
  const orientationAvailable = typeof orientationApi.lock === 'function';

  useEffect(
    () => () => {
      void sentinelRef.current?.release();
      orientationApi.unlock?.();
    },
    [orientationApi],
  );

  const toggleWakeLock = async () => {
    if (sentinelRef.current && !sentinelRef.current.released) {
      await sentinelRef.current.release();
      sentinelRef.current = undefined;
      setWakeLocked(false);
      return;
    }
    const wakeLock = (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
      .wakeLock;
    sentinelRef.current = await wakeLock.request('screen');
    setWakeLocked(true);
  };

  const setOrientationLock = async (next?: 'portrait' | 'landscape') => {
    if (!next) {
      orientationApi.unlock?.();
      setOrientation(undefined);
      return;
    }
    await orientationApi.lock?.(next);
    setOrientation(next);
  };
  return {
    wakeLockAvailable,
    orientationAvailable,
    wakeLocked,
    orientation,
    toggleWakeLock,
    setOrientationLock,
  };
}
