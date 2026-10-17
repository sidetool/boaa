import type { UiSurfaceAction } from '../../../../packages/extension-contracts/ui-lifecycle';
/** Trusted bootstrap handles only leaving the surface. Guest code still owns its local UI. */
export function bindSurfaceKeys(send: (action: UiSurfaceAction) => void): () => void {
  const listener = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      send('escape');
    } else if (event.key === 'Tab') {
      const elements = [
        ...document.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
        ),
      ]
        .filter(
          (e) =>
            e.tabIndex >= 0 &&
            !e.matches(':disabled') &&
            !e.closest('[inert], [hidden]') &&
            e.getClientRects().length > 0 &&
            !['hidden', 'collapse'].includes(getComputedStyle(e).visibility),
        )
        .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
      const active = document.activeElement;
      // Let custom/shadow widgets own their internal tab order instead of treating them as an empty surface.
      if (active?.shadowRoot || (active && active !== document.body && !elements.includes(active as HTMLElement)))
        return;
      const index = elements.indexOf(active as HTMLElement);
      if (!elements.length || index < 0 || (event.shiftKey ? index === 0 : index === elements.length - 1)) {
        event.preventDefault();
        send(event.shiftKey ? 'previous' : 'next');
      }
    }
  };
  addEventListener('keydown', listener, true);
  return () => removeEventListener('keydown', listener, true);
}
