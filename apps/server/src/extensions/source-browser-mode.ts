import type { CompatibilityPreference } from '../../../../src/extensions/packages/compatibility-preferences.js';

export const SOURCE_BROWSER_MODE_KEY = '__boaa_webview_mode';
export type SourceBrowserMode = 'camoufox';
/** Legacy per-source values remain readable. The installed server runtime owns engine selection. */
export function sourceBrowserMode(value: unknown): SourceBrowserMode | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (!['camoufox', 'browser', 'broker', 'patchright'].includes(value as string))
    throw new Error('compatibility_preferences_invalid');
  return 'camoufox';
}

export const SOURCE_BROWSER_USAGE_KEY = '__boaa_browser_usage';
export type SourceBrowserUsage = 'off' | 'http-first' | 'always';

export function sourceBrowserUsage(value: unknown): SourceBrowserUsage {
  if (value === null || value === undefined || value === '') return 'http-first';
  if (value !== 'off' && value !== 'http-first' && value !== 'always')
    throw new Error('compatibility_preferences_invalid');
  return value;
}

export function sourceBrowserFields(usage: unknown): CompatibilityPreference[] {
  return [
    {
      key: SOURCE_BROWSER_USAGE_KEY,
      title: '브라우저 사용',
      summary: '자동은 필요한 경우에만 설치된 브라우저를 사용해요.',
      kind: 'select',
      secret: false,
      value: sourceBrowserUsage(usage),
      choices: [
        { label: '자동 (기본)', value: 'http-first' },
        { label: '사용 안 함', value: 'off' },
        { label: '항상 사용', value: 'always' },
      ],
    },
  ];
}
