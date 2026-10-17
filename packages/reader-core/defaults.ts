import type { ReadingProfile, TTSPlaybackSettings } from '@boaa/contracts';

export const DEFAULT_TTS_PLAYBACK_SETTINGS: TTSPlaybackSettings = {
  schemaVersion: 1,
  rate: 1,
  pitch: 1,
  volume: 1,
  sentencePauseMs: 180,
  paragraphPauseMs: 420,
  chapterPauseMs: 900,
  chapterEndBehavior: 'stop',
  footnotePlayback: 'end_of_chapter',
  offlineOnly: false,
  skippedContentTypes: [],
};

export const DEFAULT_READING_PROFILE: ReadingProfile = {
  schemaVersion: 1,
  theme: 'dark',
  fontId: 'builtin-serif',
  fontSize: 18,
  fontWeight: 400,
  lineHeight: 1.85,
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: 1.15,
  firstLineIndent: 0,
  textAlign: 'start',
  lineBreak: 'default',
  fontStyle: 'normal',
  textDecoration: 'none',
  marginX: 12,
  marginY: 4,
  contentWidth: 760,
  brightness: 1,
  flow: 'scroll',
  modeLock: 'auto',
  pageTurnMotion: 'smooth',
  pageSpread: 'single',
};

export const DEFAULT_GESTURE_BINDINGS = {
  tapLeft: 'previous_page',
  tapCenter: 'toggle_chrome',
  tapRight: 'next_page',
  swipeLeft: 'next_page',
  swipeRight: 'previous_page',
} as const;
