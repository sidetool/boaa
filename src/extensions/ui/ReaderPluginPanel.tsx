import { useEffect, useRef, useState } from 'react';
import type { UiSurfaceAction } from '../../../packages/extension-contracts/ui-lifecycle';
import { useReaderPlugins } from './ReaderPluginProvider';
import { type ReaderPluginEntry, type PanelLease } from './reader-plugin-host';
import { readerPluginError } from './reader-plugin-errors';
export function ReaderPluginPanel({
  entry,
  theme,
  close,
}: {
  entry: ReaderPluginEntry;
  theme: 'light' | 'dark';
  close: () => void;
}) {
  const { host, snapshot } = useReaderPlugins();
  const container = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [lease, setLease] = useState<PanelLease>();
  const [status, setStatus] = useState('플러그인 준비 중');
  const [error, setError] = useState<string>();
  const readerKey = snapshot.reader?.key;
  useEffect(() => {
    if (!host || !container.current || !readerKey) return;
    let current = true;
    setError(undefined);
    setStatus('플러그인 준비 중');
    const surface = (action: UiSurfaceAction) => {
      if (!current) return;
      if (action === 'escape') {
        closeRef.current();
        return;
      }
      const panel = container.current?.closest('.addon-panel');
      const target =
        action === 'previous'
          ? panel?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
          : panel?.querySelector<HTMLElement>('[data-reader-addon-close]');
      target?.focus();
    };
    const next = host.mount(
      entry,
      container.current,
      { theme: themeRef.current, locale: 'ko', panelId: entry.panelId },
      surface,
    );
    setLease(next);
    void next.ready.then(
      () => {
        if (current) setStatus('');
      },
      (e: unknown) => {
        if (current) {
          setStatus('');
          setError(readerPluginError(e));
        }
      },
    );
    const timer = setInterval(() => {
      void next.ready
        .then((instance) => {
          if (current && instance.state === 'stopped')
            setError(readerPluginError({ code: instance.failure ?? 'PLUGIN_STOPPED' }));
        })
        .catch(() => {});
    }, 500);
    return () => {
      current = false;
      clearInterval(timer);
      void next.close().catch(() => {});
      // Sharing removes its toolbar button. Restore to the Reader only if no newer layer owns focus.
      requestAnimationFrame(() => {
        if (host.getSnapshot().reader?.key !== readerKey || document.querySelector('[role="dialog"]')) return;
        if (document.activeElement === document.body)
          document.querySelector<HTMLElement>('.reader-screen [data-reader-layer].is-active')?.focus();
      });
    };
  }, [host, entry, readerKey]);
  useEffect(() => {
    if (!host || !lease) return;
    let current = true;
    void lease.ready
      .then((instance) => (current ? host.invokePending(lease, entry, instance) : undefined))
      .catch((e: unknown) => {
        if (current) setError(readerPluginError(e));
      });
    return () => {
      current = false;
    };
  }, [host, lease, entry, snapshot.shareSequence]);
  useEffect(() => {
    let current = true;
    void lease?.ready
      .then((instance) =>
        current ? instance.updateContext({ theme, locale: 'ko', panelId: entry.panelId }) : undefined,
      )
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [lease, theme, entry.panelId]);
  if (!host || !readerKey)
    return <p role="alert">원문 정보를 확인할 수 없어 플러그인을 열지 못했습니다. 책을 다시 열어 주세요.</p>;
  return (
    <div className="reader-plugin-panel">
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="reader-plugin-surface" ref={container} />
    </div>
  );
}
