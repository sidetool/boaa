import { useEffect } from 'react';
import { isAndroidBackKeyboardEvent } from '../platform/android/app-navigation';

/** Sheet owns dismissal; native back also requires defaultPrevented to avoid leaving the reader. */
export function useReaderOverflowBack(open: boolean) {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const handled = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isAndroidBackKeyboardEvent(event)) event.preventDefault();
    };
    // Sheet stops propagation, but other capture listeners on this same window still run.
    const options = { capture: true };
    window.addEventListener('keydown', handled, options);
    return () => window.removeEventListener('keydown', handled, options);
  }, [open]);
}
