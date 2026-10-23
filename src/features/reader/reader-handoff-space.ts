/** A short final page still needs its empty lower area during native handoff.
 * Keep only the missing scroll range; removing it while occupied would clamp
 * scrollTop and move the text. Appending a chapter or scrolling up frees it.
 */
export function reserveHandoffSpace(root: HTMLElement, space: HTMLElement, targetTop: number): void {
  const missing = Math.ceil(targetTop - Math.max(0, root.scrollHeight - root.clientHeight));
  if (missing > 0) space.style.height = `${space.offsetHeight + missing}px`;
}

export function releaseHandoffSpace(root: HTMLElement, space: HTMLElement): void {
  // Most frames have no reservation; avoid a layout read on the normal scroll path.
  const height = Number.parseFloat(space.style.height) || 0;
  if (height > 0 && root.scrollTop <= Math.max(0, root.scrollHeight - height - root.clientHeight) - 1)
    space.style.height = '0px';
}
