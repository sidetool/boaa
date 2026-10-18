import { useEffect, useMemo } from 'react';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { IndexedDbReaderPersonalizationRepository } from '../../repositories/indexeddb-reader-personalization-repository';
import { ReaderSessionTracker } from '../reader/use-reader-session';
import { localSessions, pending } from './source-work-reading-time';

/** Stream-only works have no server book row. Keep their timed sessions scoped to this device/account. */
export function useSourceWorkReadingTime(id: string | undefined, active: boolean): void {
  const database = useOptionalAppRuntime()?.readerRuntime.auxiliaryDatabase;
  const sessions = useMemo(
    () => (database ? new IndexedDbReaderPersonalizationRepository(database) : localSessions),
    [database],
  );
  useEffect(() => {
    if (!id || !active) return;
    const tracker = new ReaderSessionTracker(
      {
        novelId: id,
        repository: {
          capabilities: {
            backend: 'indexeddb',
            readingTimePersistence: 'session_only',
            syncStorage: 'local_outbox',
            remoteEventApply: false,
            parsedNovelImport: 'snapshot',
          },
        },
        personalizationRepository: sessions,
        onCommitted: () => undefined,
        onFailed: () => undefined,
        onDisplayChanged: () => undefined,
      },
      Date.now(),
    );
    const flush = () => {
      const work = tracker.flush();
      pending.set(id, work);
      void work.finally(() => {
        if (pending.get(id) === work) pending.delete(id);
      });
    };
    const environment = () => {
      tracker.setEnvironment(document.visibilityState !== 'hidden', document.hasFocus());
      flush();
    };
    const interact = () => tracker.interact();
    environment();
    const timer = window.setInterval(flush, 30_000);
    document.addEventListener('visibilitychange', environment);
    window.addEventListener('focus', environment);
    window.addEventListener('blur', environment);
    window.addEventListener('pagehide', environment);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      window.addEventListener(type, interact, { passive: true });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', environment);
      window.removeEventListener('focus', environment);
      window.removeEventListener('blur', environment);
      window.removeEventListener('pagehide', environment);
      for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(type, interact);
      tracker.setEnvironment(false, false);
      flush();
    };
  }, [id, active, sessions]);
}
