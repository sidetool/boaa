import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
/** Device preferences: browsing caches must never change another reader's downloads. */
export interface SourceReadingPreferences {
  mode: 'stream-save' | 'stream' | 'download';
  textMode: 'library' | 'stream';
  listMinutes: 0 | 2 | 30 | 360;
  coverHours: 0 | 1 | 24 | 168 | 720 | 2160;
  imageMinutes: 0 | 2 | 10;
  prefetch: 0 | 2 | 4 | 5 | 8 | 10;
}
export const sourceReadingDefaults: SourceReadingPreferences = {
  mode: 'stream',
  textMode: 'library',
  listMinutes: 30,
  coverHours: 720,
  imageMinutes: 2,
  prefetch: 5,
};
const key = 'boaa.source-reading.v1';
export const sourceReadingPreferenceEvent = 'boaa-source-reading-preferences';
export function sourceReadingPreferences(scope?: string): SourceReadingPreferences {
  try {
    const value = JSON.parse(
      (scope ? localStorage.getItem(`${key}:${scope}`) : readBrandStorage(localStorage, key)) ?? '{}',
    );
    return {
      textMode: value.textMode === 'stream' ? 'stream' : 'library',
      mode: ['stream-save', 'stream', 'download'].includes(value.mode) ? value.mode : sourceReadingDefaults.mode,
      listMinutes: [0, 2, 30, 360].includes(value.listMinutes) ? value.listMinutes : 30,
      coverHours: [0, 1, 24, 168, 720, 2160].includes(value.coverHours)
        ? value.coverHours
        : sourceReadingDefaults.coverHours,
      imageMinutes: [0, 2, 10].includes(value.imageMinutes) ? value.imageMinutes : 2,
      prefetch: [0, 2, 4, 5, 8, 10].includes(value.prefetch) ? value.prefetch : sourceReadingDefaults.prefetch,
    };
  } catch {
    return { ...sourceReadingDefaults };
  }
}
export function saveSourceReadingPreferences(patch: Partial<SourceReadingPreferences>, scope?: string) {
  const value = JSON.stringify({ ...sourceReadingPreferences(scope), ...patch });
  if (scope) localStorage.setItem(`${key}:${scope}`, value);
  else writeBrandStorage(localStorage, key, value);
  window.dispatchEvent(new Event(sourceReadingPreferenceEvent));
}
