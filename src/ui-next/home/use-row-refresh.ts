import { useEffect, useRef } from 'react';
import type { HomeRowView } from './contract';

/** Mounted home rows refresh only after expiry or a return to the visible app. */
export function useRowRefresh(row: HomeRowView, near: boolean) {
  const current = useRef(row);
  current.current = row;
  const canLoad = Boolean(row.requestLoad);
  useEffect(() => {
    if (!near || !canLoad) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') current.current.requestLoad?.();
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [near, row.loadKey, canLoad]);
  useEffect(() => {
    if (!near || !row.refreshAt || row.refreshing) return;
    const timer = setTimeout(
      () => {
        if (document.visibilityState !== 'hidden') current.current.requestLoad?.();
      },
      Math.max(0, row.refreshAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [near, row.refreshAt, row.refreshing]);
}
