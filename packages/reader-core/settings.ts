import { normalizeHomeRows, normalizeStartupScreen } from './home-settings.js';
import { normalizeRecentSearches } from './search-settings.js';
export { normalizeRecentSearches, MAX_RECENT_SEARCHES, MAX_SEARCH_QUERY_LENGTH } from './search-settings.js';
export { normalizeHomeRows, normalizeHomeSourceSection, MAX_HOME_ROWS, MAX_HOME_ROWS_BYTES } from './home-settings.js';
import type { ReaderSettings } from '@boaa/contracts';
import { DEFAULT_TTS_PLAYBACK_SETTINGS, DEFAULT_GESTURE_BINDINGS, DEFAULT_READING_PROFILE } from './defaults.js';

export const PARAGRAPHS_PER_PAGE = 120;

export const defaultSettings: ReaderSettings = {
  id: 'reader-settings',
  applicationTheme: 'dark',
  theme: 'dark',
  font: 'serif',
  fontSize: 18,
  lineHeight: 1.85,
  paragraphSpacing: 1.15,
  marginX: 12,
  marginY: 4,
  contentWidth: 760,
  flow: 'scroll',
  ttsSpeed: 1,
  ttsPlayback: DEFAULT_TTS_PLAYBACK_SETTINGS,
  readingProfile: DEFAULT_READING_PROFILE,
  aiWorkflows: { schemaVersion: 1, bookOverrides: {} },
  gestureBindings: DEFAULT_GESTURE_BINDINGS,
  keepScreenChrome: false,
};

export function normalizeReaderSettings(settings: Partial<ReaderSettings> = {}): ReaderSettings {
  const record = settings as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, '_boaaIntegrations')) {
    const previous = record._moyaIntegrations ?? record._noveldeskIntegrations;
    if (previous !== undefined) settings = { ...settings, _boaaIntegrations: previous } as Partial<ReaderSettings>;
  }
  return {
    ...defaultSettings,
    ...settings,
    homeRows: normalizeHomeRows(settings.homeRows),
    recentSearches:
      settings.recentSearches === undefined ? undefined : normalizeRecentSearches(settings.recentSearches),
    startupScreen: normalizeStartupScreen(settings.startupScreen),
    ttsPlayback: {
      ...defaultSettings.ttsPlayback,
      ...settings.ttsPlayback,
      rate: settings.ttsPlayback?.rate ?? settings.ttsSpeed ?? defaultSettings.ttsPlayback.rate,
    },
    readingProfile: { ...defaultSettings.readingProfile, ...settings.readingProfile },
    aiWorkflows: {
      ...defaultSettings.aiWorkflows!,
      ...settings.aiWorkflows,
      bookOverrides: { ...defaultSettings.aiWorkflows?.bookOverrides, ...settings.aiWorkflows?.bookOverrides },
    },
    gestureBindings: { ...defaultSettings.gestureBindings, ...settings.gestureBindings },
  };
}
