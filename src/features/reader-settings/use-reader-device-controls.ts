import { useEffect, useState, useSyncExternalStore } from 'react';
import { ReaderWakeLock, type ReaderWakeLockSentinel } from './reader-wake-lock';

const readerWakeLock = new ReaderWakeLock(
  () =>
    (
      navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<ReaderWakeLockSentinel> } }
    ).wakeLock.request('screen'),
  () => document.visibilityState === 'visible',
);

/** Mounted by App so dismissing the settings sheet cannot release the screen lock. */
export function useReaderWakeLockOwner(active: boolean) {
  useEffect(() => {
    document.addEventListener('visibilitychange', readerWakeLock.visibilityChanged);
    window.addEventListener('focus', readerWakeLock.visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', readerWakeLock.visibilityChanged);
      window.removeEventListener('focus', readerWakeLock.visibilityChanged);
      readerWakeLock.dispose();
    };
  }, []);
  useEffect(() => readerWakeLock.setActive(active), [active]);
}

interface OrientationLike {
  lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
  unlock?: () => void;
}

/** Settings subscribe to the reader-owned lock; orientation keeps its existing lifetime. */
export function useReaderDeviceControls() {
  const wakeLocked = useSyncExternalStore(readerWakeLock.subscribe, readerWakeLock.snapshot, () => false);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>();
  const wakeLockAvailable = Boolean((navigator as Navigator & { wakeLock?: unknown }).wakeLock);
  const orientationApi = screen.orientation as ScreenOrientation & OrientationLike;
  const orientationAvailable = typeof orientationApi.lock === 'function';

  useEffect(
    () => () => {
      orientationApi.unlock?.();
    },
    [orientationApi],
  );

  const toggleWakeLock = () => readerWakeLock.toggle();

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
