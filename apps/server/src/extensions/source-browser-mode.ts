export const SOURCE_BROWSER_MODE_KEY = '__boaa_webview_mode';
export type SourceBrowserMode = 'camoufox';
/** Accept saved legacy values, but never select an old engine or transport. */
export function sourceBrowserMode(value: unknown): SourceBrowserMode | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (!['camoufox', 'browser', 'broker', 'patchright'].includes(value as string))
    throw new Error('compatibility_preferences_invalid');
  return 'camoufox';
}
