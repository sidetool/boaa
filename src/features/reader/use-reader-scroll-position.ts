import { elementScroll, observeElementOffset, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';
import { cancelVirtualScroll } from './cancel-virtual-scroll';

const SETTLE_MS = 250;
const EPSILON = 2;

// DOM scroll coordinates and measured document coordinates may temporarily differ.
// Move the rows by the opposite size delta while native scrolling owns the viewport;
// rebase both coordinates together after it settles, without moving the visible text.
export function useReaderScrollPosition<T extends HTMLElement>(
  rootRef: RefObject<T>,
  contentRef: RefObject<HTMLElement>,
  active: boolean,
  nativeInput = true,
  pinEnd = true,
) {
  type ReaderVirtualizer = Virtualizer<T, Element>;
  const state = useRef({
    shift: 0,
    measuredCompensation: 0,
    pinned: false,
    touching: false,
    scrolling: false,
    lastY: 0,
    offset: 0,
    max: 0,
    generation: 0,
    navigation: true,
    structuralAnchorIndex: undefined as number | undefined,
  });
  const instanceRef = useRef<ReaderVirtualizer>();
  const pendingRebase = useRef<number>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [, render] = useReducer((value: number) => value + 1, 0);
  const enabled = useRef(active);
  enabled.current = active;
  const acceptsInput = useRef(nativeInput);
  acceptsInput.current = nativeInput;

  const beginNavigation = useCallback(() => {
    const current = state.current;
    current.pinned = false;
    current.structuralAnchorIndex = undefined;
    current.navigation = true;
    return ++current.generation;
  }, []);
  const isCurrentNavigation = useCallback(
    (generation: number) => state.current.navigation && state.current.generation === generation,
    [],
  );
  const cancelNavigation = useCallback(() => {
    state.current.navigation = false;
    state.current.generation += 1;
    cancelVirtualScroll(instanceRef.current);
  }, []);
  const resetMeasurements = useCallback(() => {
    clearTimeout(timer.current);
    pendingRebase.current = undefined;
    state.current.shift = 0;
    state.current.structuralAnchorIndex = undefined;
    if (instanceRef.current) instanceRef.current.scrollOffset = rootRef.current?.scrollTop ?? 0;
  }, [rootRef]);
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const current = state.current;
    if (!enabled.current || current.touching || current.scrolling || (!current.shift && !current.pinned)) return;
    timer.current = setTimeout(() => {
      const root = rootRef.current;
      if (!root || !enabled.current || current.touching || current.scrolling) return;
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop < 0 || root.scrollTop > max + EPSILON) return;
      const target = (current.pinned ? max : root.scrollTop) + current.shift;
      if (!current.shift && Math.abs(root.scrollTop - target) <= EPSILON) return;
      pendingRebase.current = target;
      current.shift = 0;
      // Keep range selection at the same document position during the commit.
      if (instanceRef.current) instanceRef.current.scrollOffset = target;
      render();
    }, SETTLE_MS);
  }, [rootRef]);

  useLayoutEffect(() => {
    const target = pendingRebase.current;
    if (target === undefined) return;
    pendingRebase.current = undefined;
    // The rows and sizer have just committed their unshifted positions. A layout
    // effect changes scrollTop before paint, so this is not a visible correction.
    if (rootRef.current) {
      // This write preserves the same visible content. Its scroll event must
      // not be mistaken for new user movement before late rows finish sizing.
      state.current.offset = target;
      rootRef.current.scrollTop = target;
    }
  });

  const observeOffset = useCallback(
    (instance: ReaderVirtualizer, callback: (offset: number, scrolling: boolean) => void) => {
      instanceRef.current = instance;
      return observeElementOffset(instance, (offset, scrolling) => {
        const current = state.current;
        const root = rootRef.current;
        if (root && enabled.current) {
          const max = Math.max(0, root.scrollHeight - root.clientHeight);
          if (pinEnd && scrolling && max > 0 && offset >= max - EPSILON) current.pinned = true;
          else if (offset < current.offset - EPSILON && offset < max - EPSILON && max === current.max)
            current.pinned = false;
          if (Math.abs(offset - current.offset) > EPSILON) current.structuralAnchorIndex = undefined;
          current.offset = offset;
          current.max = max;
        }
        current.scrolling = scrolling;
        // Positive compensation can put the chapter start above native offset 0.
        // Once a user reaches that boundary, waiting for touchend strands them
        // in the middle of the chapter. Rebase at the exhausted native boundary;
        // the layout effect commits rows and scrollTop together before paint.
        if (enabled.current && !current.navigation && offset <= EPSILON && current.shift > EPSILON) {
          clearTimeout(timer.current);
          pendingRebase.current = offset + current.shift;
          current.shift = 0;
          callback(pendingRebase.current, scrolling);
          render();
        } else callback(offset + current.shift, scrolling);
        schedule();
      });
    },
    [rootRef, schedule, pinEnd],
  );

  const adjustMeasuredSize = useCallback(
    (item: VirtualItem, delta: number, instance: ReaderVirtualizer) => {
      const offset = instance.scrollOffset ?? 0;
      // Use the visible row identity, not stale item.end coordinates. Multiple
      // ResizeObserver entries share the old measurement batch; increasing the
      // offset for one must not make later, below-screen rows look "above" it.
      if (item.index < (state.current.structuralAnchorIndex ?? instance.range?.startIndex ?? 0)) {
        state.current.shift += delta;
        state.current.measuredCompensation += delta;
        instance.scrollOffset = offset + delta;
        schedule();
      }
      // Own the compensation here: the library's immediate Android scroll write
      // and delayed iOS write would both compete with native momentum.
      return false;
    },
    [schedule],
  );

  const scrollTo = useCallback(
    (offset: number, options: Parameters<typeof elementScroll>[1], instance: ReaderVirtualizer) => {
      // A late scrollToIndex reconciliation must not chase an old restore/search
      // target after the user has taken over scrolling.
      if (!state.current.navigation && options.adjustments === undefined) return;
      state.current.pinned = false;
      if (state.current.shift || pendingRebase.current !== undefined) {
        // A jump to the start may be outside the temporarily shifted native
        // range. Commit its destination and the unshifted rows together; an old
        // idle rebase must not overwrite the newly requested destination.
        clearTimeout(timer.current);
        pendingRebase.current = offset + (options.adjustments ?? 0);
        state.current.shift = 0;
        instance.scrollOffset = pendingRebase.current;
        render();
      } else elementScroll(offset, options, instance);
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    const current = state.current;
    const touchStart = (event: TouchEvent) => {
      if (acceptsInput.current) cancelNavigation();
      state.current.touching = true;
      state.current.lastY = event.touches[0]?.clientY ?? 0;
      clearTimeout(timer.current);
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      if (y > state.current.lastY + 1) state.current.pinned = false;
      state.current.lastY = y;
    };
    const touchEnd = () => {
      state.current.touching = false;
      schedule();
    };
    const wheel = (event: WheelEvent) => {
      if (!acceptsInput.current) return;
      cancelNavigation();
      if (event.deltaY < 0) state.current.pinned = false;
    };
    const key = (event: KeyboardEvent) => {
      if (!acceptsInput.current) return;
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      cancelNavigation();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
        state.current.pinned = false;
    };
    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchmove', touchMove, { passive: true });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('touchcancel', touchEnd, { passive: true });
    root.addEventListener('wheel', wheel, { passive: true });
    root.addEventListener('keydown', key);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    if (contentRef.current) observer?.observe(contentRef.current);
    observer?.observe(root);
    return () => {
      clearTimeout(timer.current);
      current.touching = false;
      current.pinned = false;
      observer?.disconnect();
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchmove', touchMove);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('touchcancel', touchEnd);
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('keydown', key);
    };
  }, [active, cancelNavigation, contentRef, rootRef, schedule]);

  const compensateStructure = useCallback(
    (delta: number, anchorIndex?: number, measuredAtAnchor?: number) => {
      state.current.structuralAnchorIndex = anchorIndex;
      if (!Number.isFinite(delta)) return;
      // Ref/ResizeObserver measurements can compensate before the structural
      // layout effect. The stable-key start delta already contains those size
      // changes. Count them once, independently of idle/native coordinate rebases.
      const appliedMeasurements =
        measuredAtAnchor === undefined ? 0 : state.current.measuredCompensation - measuredAtAnchor;
      const remainingDelta = delta - appliedMeasurements;
      if (Math.abs(remainingDelta) < 0.01) return;
      const offset = rootRef.current?.scrollTop ?? 0;
      // Removing a prefix can shrink the committed sizer below the old native
      // offset before this layout effect runs. The browser clamps scrollTop;
      // preserve the last observed coordinate as well as the row-start delta.
      const clamped = delta < 0 ? Math.max(0, state.current.offset - offset) : 0;
      state.current.shift += remainingDelta + clamped;
      state.current.offset = offset;
      state.current.pinned = false;
      const target = offset + state.current.shift;
      // A prepend can arrive while a finger is held at scrollTop=0. No native
      // scroll event fires there, so open the newly available range ourselves.
      if (!state.current.navigation && offset <= EPSILON && state.current.shift > EPSILON) {
        pendingRebase.current = target;
        state.current.shift = 0;
      }
      if (instanceRef.current) instanceRef.current.scrollOffset = target;
      schedule();
      render();
    },
    [rootRef, schedule],
  );

  return {
    // Keep the old native range for the structural DOM commit itself. The
    // following layout compensation replaces this temporary floor before paint;
    // otherwise a prefix removal can clamp scrollTop and interrupt momentum.
    preserveNativeRange(height: number, changingStructure: boolean) {
      return enabled.current && changingStructure ? Math.max(height, rootRef.current?.scrollHeight ?? 0) : height;
    },
    compensateStructure,
    observeOffset,
    scrollTo,
    adjustMeasuredSize,
    beginNavigation,
    cancelNavigation,
    isCurrentNavigation,
    resetMeasurements,
    get measuredCompensation() {
      return state.current.measuredCompensation;
    },
    get shift() {
      return state.current.shift;
    },
  };
}
