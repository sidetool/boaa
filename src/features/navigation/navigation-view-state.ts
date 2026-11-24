import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type SetStateAction } from 'react';

const values = new Map<string, unknown>();
export function clearNavigationViewState() {
  values.clear();
}
export function rememberNavigationViewState(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  values.delete(key);
  values.set(key, value);
  if (values.size > 200) values.delete(values.keys().next().value!);
}

/** Bounded, tab-local presentation only; no imported text or reader position. */
export function useNavigationViewState<T>(
  key: string,
  initial: T | (() => T),
): [T, (value: SetStateAction<T>) => void] {
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const read = useCallback(
    () =>
      values.has(key)
        ? (values.get(key) as T)
        : typeof initialRef.current === 'function'
          ? (initialRef.current as () => T)()
          : initialRef.current,
    [key],
  );
  const [state, setState] = useState(() => ({ key, value: read() }));
  const value = state.key === key ? state.value : read();
  const updateValue = useCallback(
    (update: SetStateAction<T>) =>
      setState((current) => {
        const previous = current.key === key ? current.value : read();
        const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
        rememberNavigationViewState(key, next);
        return { key, value: next };
      }),
    [key, read],
  );
  return [value, updateValue];
}

export function hasNavigationScroll(key: string | undefined) {
  return Boolean(key && values.get(`scroll:${key}`));
}

/** Restore the activated card once, including cards populated after the first render. */
export function useNavigationResultFocus(ref: RefObject<HTMLElement>, key: string) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const focusKey = `focus:${key}`;
    const pending = values.get(focusKey) as { rail: string; item: string } | undefined;
    const remember = (event: MouseEvent) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-navigation-item]') : null;
      const rail = button?.closest<HTMLElement>('[data-navigation-rail]')?.dataset.navigationRail;
      if (rail && button?.dataset.navigationItem) {
        rememberNavigationViewState(focusKey, { rail, item: button.dataset.navigationItem });
      }
    };
    root.addEventListener('click', remember, true);
    let observer: MutationObserver | undefined;
    let frame: number | undefined;
    if (pending) {
      const restore = () => {
        if (values.get(focusKey) !== pending) return true;
        const button = [...root.querySelectorAll<HTMLElement>('[data-navigation-item]')].find(
          (el) =>
            el.dataset.navigationItem === pending.item &&
            el.closest<HTMLElement>('[data-navigation-rail]')?.dataset.navigationRail === pending.rail,
        );
        if (!button) return false;
        values.delete(focusKey);
        button.focus({ preventScroll: true });
        // A newly read work may move within its rail between visits.
        frame = requestAnimationFrame(() => {
          if (document.activeElement === button)
            button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        });
        return true;
      };
      if (!restore() && typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => {
          if (restore()) observer?.disconnect();
        });
        observer.observe(root, { subtree: true, childList: true });
      }
    }
    // If the reader starts another interaction, a late row should not steal focus.
    const stopWaiting = () => {
      observer?.disconnect();
      if (pending && values.get(focusKey) === pending) values.delete(focusKey);
    };
    root.addEventListener('pointerdown', stopWaiting, true);
    root.addEventListener('keydown', stopWaiting, true);
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener('click', remember, true);
      root.removeEventListener('pointerdown', stopWaiting, true);
      root.removeEventListener('keydown', stopWaiting, true);
    };
  }, [ref, key]);
}

export function useNavigationScroll(
  ref: RefObject<HTMLElement>,
  key: string | undefined,
  ready = true,
  axis: 'scrollTop' | 'scrollLeft' = 'scrollTop',
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !ready || !key) return;
    const storageKey = `scroll:${key}`;
    const target = Number(values.get(storageKey) ?? 0);
    let restoring = true;
    const save = () => {
      if (!restoring) rememberNavigationViewState(storageKey, element[axis]);
    };
    element.addEventListener('scroll', save, { passive: true });
    element[axis] = target;
    const frame = requestAnimationFrame(() => {
      element[axis] = target;
      restoring = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', save);
    };
  }, [key, ready, ref, axis]);
}
