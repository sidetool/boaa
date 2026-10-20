export const DEFAULT_PLAIN_TTS_BATCH_CHARACTERS = 700;
export const MIN_PLAIN_TTS_BATCH_CHARACTERS = 200;
export const MAX_PLAIN_TTS_BATCH_CHARACTERS = 2000;
export function normalizePlainTTSBatchCharacters(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(MIN_PLAIN_TTS_BATCH_CHARACTERS, Math.min(MAX_PLAIN_TTS_BATCH_CHARACTERS, value)))
    : DEFAULT_PLAIN_TTS_BATCH_CHARACTERS;
}
