import { createPageCurl } from './page-curl-renderer';
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

type Direction = -1 | 1;
type Turn<T> = {
  id: number;
  scope: string;
  position: string | number;
  direction: Direction;
  visualDirection: Direction;
  controller: AbortController;
  preview?: T;
  prepared: boolean;
  ready: boolean;
  progress: number;
  width: number;
  released?: boolean;
  committing: boolean;
  originY: number;
  pullY: number;
  curl?: ReturnType<typeof createPageCurl>;
};

/** One cancellable turn owns both the preview and its eventual navigation.
 * Pointer frames only update compositor properties, never React state or reading progress.
 */
export function usePageTurn<T>(input: {
  stage: RefObject<HTMLElement | null>;
  enabled: boolean;
  scope: string;
  position: string | number;
  rtl?: boolean;
  manualReady?: boolean;
  curl?: boolean;
  prepare(direction: Direction, signal: AbortSignal): Promise<T | undefined>;
  commit(preview: T): void | Promise<void>;
  edge?(direction: Direction): void | Promise<void>;
  error?(error: unknown): void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const live = useRef<Turn<T>>();
  const sequence = useRef(0);
  const frame = useRef<number>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const deadline = useRef<ReturnType<typeof setTimeout>>();
  const transitionCleanup = useRef<() => void>();
  const pointer = useRef<{ id: number; x: number; y: number; at: number; claimed: boolean }>();
  // Cancelling async work must not give its claimed gesture back to legacy
  // swipe handlers when the same finger is eventually lifted.
  const consumedPointer = useRef<number>();
  const [preview, setPreview] = useState<T>();
  const [active, setActive] = useState(false);

  const paint = useCallback((progress: number, phase: 'dragging' | 'settling', duration = 0) => {
    const stage = latest.current.stage.current;
    const turn = live.current;
    if (!stage || !turn) return;
    stage.dataset.turnPhase = phase;
    // Own the visual path from the first pointer frame. Falling back to flat
    // transforms while awaiting React's preview causes the sheet to jump back
    // to its resting position as soon as the curl is mounted.
    if (latest.current.curl) stage.dataset.turnRenderer = 'curl';
    stage.style.setProperty('--turn-dir', String(turn.visualDirection));
    stage.style.setProperty('--turn-forward', turn.direction === 1 ? '1' : '0');
    stage.style.setProperty('--turn-width', `${turn.width}px`);
    stage.style.setProperty('--turn-settle-ms', `${duration}ms`);
    stage.style.setProperty('--turn-progress', String(progress));
    if (turn.ready && turn.curl) turn.curl.draw(progress, turn.originY - turn.curl.top, turn.pullY);
  }, []);
  const cancel = useCallback(() => {
    const turn = live.current;
    turn?.controller.abort();
    turn?.curl?.destroy();
    live.current = undefined;
    if (pointer.current?.claimed) consumedPointer.current = pointer.current.id;
    pointer.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    clearTimeout(timer.current);
    clearTimeout(deadline.current);
    transitionCleanup.current?.();
    transitionCleanup.current = undefined;
    const stage = latest.current.stage.current;
    if (stage && turn) {
      delete stage.dataset.turnPhase;
      delete stage.dataset.turnRenderer;
      for (const name of ['--turn-progress', '--turn-dir', '--turn-forward', '--turn-width', '--turn-settle-ms'])
        stage.style.removeProperty(name);
    }
    setPreview(undefined);
    setActive(false);
  }, []);
  const settle = useCallback(
    (turn: Turn<T>, commit: boolean) => {
      if (live.current !== turn || turn.committing) return;
      turn.released = commit;
      if (commit && !turn.ready) return;
      // A late preparation must not interrupt the return animation of a cancelled drag.
      if (!commit && !turn.ready) {
        cancel();
        return;
      }
      clearTimeout(deadline.current);
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const curling = latest.current.curl && turn.preview !== undefined;
      const duration = reduced
        ? 0
        : Math.round((curling ? 260 : 120) + (curling ? 180 : 120) * (commit ? 1 - turn.progress : turn.progress));
      if (!curling)
        paint(commit ? (turn.preview === undefined ? Math.min(0.12, turn.progress) : 1) : 0, 'settling', duration);
      let finished = false;
      const finish = async () => {
        if (finished || live.current !== turn) return;
        if (
          turn.scope !== latest.current.scope ||
          turn.position !== latest.current.position ||
          !latest.current.enabled
        ) {
          cancel();
          return;
        }
        finished = true;
        clearTimeout(timer.current);
        transitionCleanup.current?.();
        transitionCleanup.current = undefined;
        if (!commit) {
          cancel();
          return;
        }
        turn.committing = true;
        try {
          if (turn.preview !== undefined) await latest.current.commit(turn.preview);
          else await latest.current.edge?.(turn.direction);
          // Let the new current layer paint beneath the final preview before removing it.
          if (live.current !== turn) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = requestAnimationFrame(() => {
              if (live.current === turn) cancel();
            });
          });
        } catch (error) {
          if (live.current !== turn) return;
          cancel();
          latest.current.error?.(error);
        }
      };
      if (curling) {
        const from = turn.progress;
        const to = commit ? 1 : 0;
        const started = performance.now();
        const animate = (now: number) => {
          if (live.current !== turn) return;
          const time = duration === 0 ? 1 : Math.max(0, Math.min(1, (now - started) / duration));
          turn.progress = from + (to - from) * (1 - Math.pow(1 - time, 3));
          paint(turn.progress, 'settling', 0);
          if (time >= 1) void finish();
          else frame.current = requestAnimationFrame(animate);
        };
        frame.current = requestAnimationFrame(animate);
        return;
      }
      const stage = latest.current.stage.current;
      const onEnd = (event: Event) => {
        if (
          (event as TransitionEvent).propertyName === 'transform' &&
          event.target instanceof Element &&
          event.target.matches('.reader-paginated-page, .fixed-doc-pages')
        )
          void finish();
      };
      stage?.addEventListener('transitionend', onEnd);
      transitionCleanup.current = () => stage?.removeEventListener('transitionend', onEnd);
      timer.current = setTimeout(
        () => {
          void finish();
        },
        duration === 0 ? 0 : duration + 80,
      );
    },
    [cancel, paint],
  );
  const completePreparation = useCallback(() => {
    const turn = live.current;
    if (!turn || !turn.prepared || turn.controller.signal.aborted || turn.committing || turn.ready) return;
    const finish = () => {
      if (live.current !== turn || turn.controller.signal.aborted) return;
      if (turn.scope !== latest.current.scope || turn.position !== latest.current.position || !latest.current.enabled) {
        cancel();
        return;
      }
      turn.ready = true;
      clearTimeout(deadline.current);
      // Draw the latest held position before making decoded snapshots visible.
      paint(turn.progress, 'dragging');
      turn.curl?.activate();
      if (turn.released !== undefined) {
        frame.current = requestAnimationFrame(() => {
          frame.current = requestAnimationFrame(() => {
            if (live.current === turn) settle(turn, turn.released!);
          });
        });
      }
    };
    if (latest.current.curl && turn.preview !== undefined) {
      if (turn.curl) return; // Snapshot decode is already pending.
      const stage = latest.current.stage.current;
      if (!stage?.querySelector('.reader-paginated-page.is-preview, .is-turn-preview')) return;
      turn.curl = createPageCurl(stage, turn.direction === 1, turn.visualDirection);
      if (!turn.curl) return;
      if (turn.curl.ready) {
        void turn.curl.ready.then(finish, (error: unknown) => {
          if (live.current !== turn || turn.controller.signal.aborted) return;
          cancel();
          latest.current.error?.(error);
        });
        return;
      }
    }
    finish();
  }, [cancel, paint, settle]);
  const ready = useCallback(() => {
    const turn = live.current;
    if (!turn || turn.controller.signal.aborted || turn.committing) return;
    turn.prepared = true;
    completePreparation();
  }, [completePreparation]);
  const begin = useCallback(
    (direction: Direction, released: boolean) => {
      if (!latest.current.enabled || live.current) return false;
      const stage = latest.current.stage.current;
      const bounds = stage?.getBoundingClientRect?.();
      const sheets = latest.current.curl
        ? [
            ...(stage?.querySelectorAll<HTMLElement>('.reader-paginated-page.is-current, .is-turn-current > article') ??
              []),
          ].map((node) => node.getBoundingClientRect())
        : [];
      const width = sheets.length
        ? Math.max(...sheets.map((r) => r.right)) - Math.min(...sheets.map((r) => r.left))
        : (stage?.clientWidth ?? 1);
      const turn: Turn<T> = {
        id: ++sequence.current,
        scope: latest.current.scope,
        position: latest.current.position,
        direction,
        visualDirection: latest.current.rtl ? (direction === 1 ? -1 : 1) : direction,
        controller: new AbortController(),
        prepared: false,
        ready: false,
        progress: 0,
        width: Math.max(1, width),
        originY: pointer.current ? pointer.current.y - (bounds?.top ?? 0) : (bounds?.height ?? 0) * 0.8,
        pullY: released ? -(bounds?.height ?? 0) * 0.18 : 0,
        released: released ? true : undefined,
        committing: false,
      };
      live.current = turn;
      setActive(true);
      paint(0, 'dragging');
      deadline.current = setTimeout(() => {
        if (live.current !== turn) return;
        cancel();
        latest.current.error?.(new Error('page_turn_timeout'));
      }, 15_000);
      void latest.current
        .prepare(direction, turn.controller.signal)
        .then((value) => {
          if (live.current !== turn || turn.controller.signal.aborted) return;
          turn.preview = value;
          setPreview(value);
          if (value === undefined || !latest.current.manualReady) ready();
        })
        .catch((error: unknown) => {
          if (live.current !== turn || turn.controller.signal.aborted) return;
          cancel();
          latest.current.error?.(error);
        });
      return true;
    },
    [cancel, paint, ready],
  );

  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [input.scope, input.enabled, cancel]);
  useLayoutEffect(() => {
    if (!live.current?.committing) cancel();
  }, [input.position, cancel]);
  useLayoutEffect(() => {
    const turn = live.current;
    if (turn?.prepared && !turn.committing && preview !== undefined && turn.preview === preview) {
      // Preparation resolves before React mounts its article. Install the curl
      // before that commit paints, even if the finger has stopped moving.
      completePreparation();
    }
  }, [preview, completePreparation]);
  useLayoutEffect(() => {
    if (!input.enabled) return;
    const hide = () => {
      if (document.visibilityState === 'hidden') cancel();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    };
  }, [cancel, input.enabled]);

  return {
    preview,
    active,
    ready,
    cancel,
    fail(error: unknown) {
      if (!live.current) return;
      cancel();
      latest.current.error?.(error);
    },
    turn: (direction: Direction) => begin(direction, true),
    down(id: number, x: number, y: number) {
      consumedPointer.current = undefined;
      if (!latest.current.enabled || live.current) return;
      pointer.current = { id, x, y, at: performance.now(), claimed: false };
    },
    move(id: number, x: number, y: number): boolean {
      if (consumedPointer.current === id) return true;
      const start = pointer.current;
      if (!start || start.id !== id) return false;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!start.claimed) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          pointer.current = undefined;
          return false;
        }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2 || performance.now() - start.at > 500) return false;
        const physical = dx < 0 ? 1 : -1;
        const direction = latest.current.rtl ? (physical === 1 ? -1 : 1) : physical;
        if (!begin(direction, false)) return false;
        start.claimed = true;
      }
      const turn = live.current;
      if (!turn || turn.released !== undefined) return start.claimed;
      const width = turn.width;
      // The outgoing held corner crosses two sheet widths; an incoming sheet
      // crosses one. Keep backward dragging attached to the user's finger.
      const travel = width * (latest.current.curl && turn.direction === 1 ? 2 : 1);
      turn.progress = Math.max(0, Math.min(1, (-dx * turn.visualDirection) / travel));
      turn.pullY = dy;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        if (live.current === turn)
          paint(turn.ready && turn.preview !== undefined ? turn.progress : Math.min(0.12, turn.progress), 'dragging');
      });
      return true;
    },
    up(id: number, x: number, cancelled = false): boolean {
      if (consumedPointer.current === id) {
        consumedPointer.current = undefined;
        return true;
      }
      const start = pointer.current;
      if (!start || start.id !== id) return false;
      pointer.current = undefined;
      if (!start.claimed) return false;
      const turn = live.current;
      if (!turn) return true;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      const distance = -(x - start.x) * turn.visualDirection;
      const velocity = distance / Math.max(1, performance.now() - start.at);
      settle(turn, !cancelled && (distance >= turn.width * 0.22 || (distance >= 35 && velocity >= 0.45)));
      return true;
    },
  };
}
