import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PluginService } from './plugin-service';
import type { PluginReaderAdapter } from './reader-session';
import { isInteractiveShortcutTarget } from '../../features/reader/use-stable-document-shortcuts';
import './reader-input.css';
const empty = () => undefined;
const noopSubscribe = () => () => {};
/** Only this host-owned, explicitly selected margin captures a hold; the text surface keeps native gestures. */
export function ReaderPluginInput({
  service,
  adapter,
  generation,
  eligible,
  onError,
}: {
  service?: PluginService;
  adapter: PluginReaderAdapter;
  generation: string;
  eligible: boolean;
  onError(message: string): void;
}) {
  const binding = useSyncExternalStore(service?.bindings.subscribe ?? noopSubscribe, service?.bindings.get ?? empty);
  const latest = useRef(adapter);
  latest.current = adapter;
  const failure = useRef(onError);
  failure.current = onError;
  const edge = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!service || !adapter.contentRevision) return;
    return service.connectReaderActions({
      ...adapter,
      state: () => latest.current.state(),
      annotationsChanged: () => latest.current.annotationsChanged?.(),
      start: (speed) => (eligible ? latest.current.start(speed) : undefined),
    });
    // Metadata belongs to the generation, not to every viewport position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, generation, adapter.repository, eligible]);
  useLayoutEffect(() => {
    if (!service || !binding || !eligible) return;
    let hold:
      | { abort: AbortController; timer: ReturnType<typeof setTimeout>; pointer?: number; x: number; y: number }
      | undefined;
    const release = () => {
      if (!hold) return;
      const previous = hold;
      hold = undefined;
      clearTimeout(previous.timer);
      // Stops host animation synchronously; guest cancellation is secondary.
      previous.abort.abort();
      if (previous.pointer !== undefined && edge.current?.hasPointerCapture(previous.pointer))
        edge.current.releasePointerCapture(previous.pointer);
    };
    const begin = (pointer?: number, x = 0, y = 0) => {
      if (hold || document.getSelection()?.isCollapsed === false) return;
      const abort = new AbortController();
      hold = {
        abort,
        pointer,
        x,
        y,
        timer: setTimeout(() => {
          void service.boundReaderCommand(binding, abort.signal).catch(() => {
            if (hold?.abort !== abort) return;
            if (!abort.signal.aborted)
              failure.current('지금은 플러그인 독서 명령을 실행할 수 없습니다. 플러그인 설정을 확인해 주세요.');
            release();
          });
        }, 500),
      };
    };
    const down = (event: PointerEvent) => {
      if (!event.isTrusted) return;
      if (hold || event.button !== 0 || !event.isPrimary || event.target !== edge.current) {
        release();
        return;
      }
      event.preventDefault();
      begin(event.pointerId, event.clientX, event.clientY);
      edge.current?.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (hold?.pointer === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 12)
        release();
    };
    const key = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      const shortcut =
        event.code === 'Space' &&
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isInteractiveShortcutTarget(event.target);
      const focused = event.target === edge.current && ['Space', 'Enter'].includes(event.code);
      if (!shortcut && !focused) {
        release();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) begin();
    };
    const hide = () => {
      if (document.hidden) release();
    };
    const cleanupBinding = service.bindings.subscribe(release);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('keydown', key, true);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'keyup', 'wheel'])
      document.addEventListener(name, release, true);
    const selectionChanged = () => {
      if (document.getSelection()?.isCollapsed === false) release();
    };
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', release);
    window.addEventListener('resize', release);
    return () => {
      release();
      cleanupBinding();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('keydown', key, true);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'keyup', 'wheel'])
        document.removeEventListener(name, release, true);
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', release);
      window.removeEventListener('resize', release);
    };
  }, [service, binding, eligible, generation]);
  if (!binding || !eligible || binding.edge === 'keyboard') return null;
  return (
    <button
      ref={edge}
      type="button"
      className={`plugin-reader-hold-edge is-${binding.edge}`}
      aria-label={`${binding.command} 길게 누르기 · 놓으면 중지`}
      title={`${binding.command} · 길게 누르거나 Alt+Shift+Space를 누르고 유지`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}
