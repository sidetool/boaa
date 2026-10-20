import { useEffect, useSyncExternalStore } from 'react';
import { ReaderWakeLock, type ReaderWakeLockSentinel } from './reader-wake-lock';
import { ReaderOrientationLock } from './reader-orientation-lock';

const readerWakeLock = new ReaderWakeLock(
  () =>
    (
      navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<ReaderWakeLockSentinel> } }
    ).wakeLock.request('screen'),
  () => document.visibilityState === 'visible',
  {
    read: () => localStorage.getItem('boaa.reader.keep-screen-on') === 'true',
    write: (enabled) => localStorage.setItem('boaa.reader.keep-screen-on', String(enabled)),
  },
);

const orientationApi = () => screen.orientation as ScreenOrientation & OrientationLike;
const readerOrientation = new ReaderOrientationLock(
  async (value) => {
    await orientationApi().lock?.(value);
  },
  () => orientationApi().unlock?.(),
  {
    read: () => {
      const value = localStorage.getItem('boaa.reader.orientation');
      return value === 'portrait' || value === 'landscape' ? value : undefined;
    },
    write: (value) => localStorage.setItem('boaa.reader.orientation', value ?? 'auto'),
  },
);

/** Mounted by App so dismissing the settings sheet cannot release the screen lock. */
export function useReaderWakeLockOwner(active: boolean) {
  useEffect(() => {
    document.addEventListener('visibilitychange', readerWakeLock.visibilityChanged);
    window.addEventListener('focus', readerWakeLock.visibilityChanged);
    const restoreOrientation = () => {
      if (document.visibilityState === 'visible') readerOrientation.reapply();
    };
    document.addEventListener('visibilitychange', restoreOrientation);
    document.addEventListener('fullscreenchange', restoreOrientation);
    window.addEventListener('focus', restoreOrientation);
    return () => {
      document.removeEventListener('visibilitychange', readerWakeLock.visibilityChanged);
      window.removeEventListener('focus', readerWakeLock.visibilityChanged);
      readerWakeLock.dispose();
      document.removeEventListener('visibilitychange', restoreOrientation);
      document.removeEventListener('fullscreenchange', restoreOrientation);
      window.removeEventListener('focus', restoreOrientation);
      readerOrientation.setActive(false);
    };
  }, []);
  useEffect(() => readerWakeLock.setActive(active), [active]);
  useEffect(() => readerOrientation.setActive(active), [active]);
}

interface OrientationLike {
  lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
  unlock?: () => void;
}

/** Settings edit saved device preferences; closing the panel does not release reader locks. */
export function useReaderDeviceControls() {
  const wakeLocked = useSyncExternalStore(readerWakeLock.subscribe, readerWakeLock.snapshot, () => false);
  const orientation = useSyncExternalStore(readerOrientation.subscribe, readerOrientation.snapshot, () => undefined);
  const wakeLockAvailable = Boolean((navigator as Navigator & { wakeLock?: unknown }).wakeLock);
  const orientationAvailable = typeof orientationApi().lock === 'function';

  const toggleWakeLock = () => readerWakeLock.toggle();

  const setOrientationLock = (next?: 'portrait' | 'landscape') => readerOrientation.setOrientation(next);
  return {
    wakeLockAvailable,
    orientationAvailable,
    wakeLocked,
    orientation,
    toggleWakeLock,
    setOrientationLock,
  };
}
