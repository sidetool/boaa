/** Application chrome stays outside the text and fixed-document reader stages. */
export function uiNextAppClass(view: string): string {
  return `app-shell${view !== 'reader' && view !== 'document' ? ' ui-next' : ''}`;
}
export function usesAppHistory(kind: string): boolean {
  return kind === 'browser' || kind === 'tauri-mobile';
}
/** Shared overlays keep their reader-independent kit styling. */
export function uiNextKitClass(className: string): string {
  return `${className} un-kit`;
}
