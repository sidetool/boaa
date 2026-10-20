/** Translation is a separate projection. These records never replace source paragraphs. */
export type TranslationProvider = 'gemini' | 'vertex' | 'openai-compatible';
export interface TranslationSettings {
  enabled: boolean;
  automatic: boolean;
  translateTitles: boolean;
  provider: TranslationProvider;
  model: string;
  targetLanguage: string;
  endpoint: string;
  project: string;
  location: string;
  chunkCharacters: number;
  concurrency: number;
  nextChapters: number;
  retries: number;
  backoffSeconds: number;
  timeoutSeconds: number;
  instructions: string;
  glossary: string;
}
export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  enabled: false,
  automatic: false,
  translateTitles: false,
  provider: 'gemini',
  model: '',
  targetLanguage: 'ko',
  endpoint: 'https://api.openai.com/v1',
  project: '',
  location: 'global',
  chunkCharacters: 6000,
  concurrency: 1,
  nextChapters: 1,
  retries: 3,
  backoffSeconds: 2,
  timeoutSeconds: 120,
  instructions: '',
  glossary: '',
};
export interface TranslationConfiguration {
  settings: TranslationSettings;
  revision: number;
  credentials: Partial<Record<TranslationProvider, { saved: boolean }>>;
  usedCharacters: number;
}
export interface TranslationParagraph {
  id: string;
  text: string;
}
/** Use the same text projection for stored and streaming EPUB/text sources. */
export function translationTextParagraphs(
  paragraphs: readonly (TranslationParagraph & { documentKind?: string })[],
): TranslationParagraph[] {
  return paragraphs
    .filter((paragraph) => !['image', 'separator'].includes(paragraph.documentKind ?? ''))
    .map((paragraph) => ({ id: paragraph.id, text: paragraph.text }));
}
export type TranslationStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export interface TranslationResult {
  id: string;
  workKey: string;
  chapterKey: string;
  sourceHash: string;
  status: TranslationStatus;
  targetLanguage: string;
  provider: TranslationProvider;
  model: string;
  paragraphs: TranslationParagraph[];
  completed: number;
  total: number;
  error?: string;
}
export interface TranslationRequest {
  workKey: string;
  chapterKey: string;
  bookId?: string;
  revision?: string;
  /** Exact displayed chapter fingerprint; permits unrelated chapter additions. */
  chapterTextHash?: string;
  /** Only transient readers send an already-authorized text snapshot. Never a URL to fetch. */
  paragraphs?: TranslationParagraph[];
  sourceLanguage?: string;
  confirmUnknownLanguage?: boolean;
  prefetch?: boolean;
  /** Look up cached results without creating a billable job. */
  lookupOnly?: boolean;
}
export function validateTranslationSettings(value: unknown): TranslationSettings {
  if (!value || typeof value !== 'object') throw new Error('translation_invalid_settings');
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_TRANSLATION_SETTINGS };
  for (const key of ['enabled', 'automatic'] as const) {
    if (typeof input[key] !== 'boolean') throw new Error('translation_invalid_settings');
    result[key] = input[key];
  }
  if (input.translateTitles !== undefined && typeof input.translateTitles !== 'boolean')
    throw new Error('translation_invalid_settings');
  result.translateTitles = input.translateTitles === true;
  if (!['gemini', 'vertex', 'openai-compatible'].includes(String(input.provider)))
    throw new Error('translation_invalid_settings');
  result.provider = input.provider as TranslationProvider;
  for (const [key, max] of Object.entries({
    model: 150,
    targetLanguage: 40,
    endpoint: 1000,
    project: 100,
    location: 50,
    instructions: 2000,
    glossary: 10000,
  })) {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max) throw new Error('translation_invalid_settings');
    Object.assign(result, { [key]: value.trim() });
  }
  if (
    ['und', 'mul', 'zxx'].includes(result.targetLanguage.toLowerCase()) ||
    !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(result.targetLanguage)
  )
    throw new Error('translation_invalid_settings');
  if (result.model && !/^[\w.\-/:]+$/.test(result.model)) throw new Error('translation_invalid_settings');
  if (!/^[a-z0-9-]*$/.test(result.project) || !/^[a-z0-9-]+$/.test(result.location))
    throw new Error('translation_invalid_settings');
  const endpoint = new URL(result.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('translation_invalid_endpoint');
  for (const [key, [min, max]] of Object.entries({
    chunkCharacters: [2000, 12000],
    concurrency: [1, 3],
    nextChapters: [0, 3],
    retries: [0, 5],
    backoffSeconds: [1, 30],
    timeoutSeconds: [15, 180],
  })) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new Error('translation_invalid_settings');
    Object.assign(result, { [key]: value });
  }
  if (result.enabled && !result.model) throw new Error('translation_model_required');
  return result;
}
/** Conservative local hint, not a paid language-detection call. Unknown never auto-starts. */
export function translationSourceLanguage(hint: unknown, text: string): string | undefined {
  if (
    typeof hint === 'string' &&
    /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(hint) &&
    !['und', 'mul', 'zxx'].includes(hint.toLowerCase())
  )
    return hint;
  return detectTranslationLanguage(text);
}
export function detectTranslationLanguage(text: string): string | undefined {
  const sample = text.slice(0, 8000);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 30) return undefined;
  const ratio = (pattern: RegExp) => (sample.match(pattern)?.length ?? 0) / letters;
  if (ratio(/[가-힣]/g) > 0.35) return 'ko';
  if (ratio(/[ぁ-ヿ]/g) > 0.12) return 'ja';
  if (ratio(/\p{Script=Han}/gu) > 0.55) return 'zh';
  // Latin script alone cannot reliably distinguish English, French, etc.
  return undefined;
}
export function translationMessage(code?: string): string {
  const messages: Record<string, string> = {
    translation_disabled: '설정에서 작품 번역을 먼저 켜 주세요.',
    translation_model_required: '사용할 번역 모델을 입력해 주세요.',
    translation_secret_required: '번역 설정에서 API 키 또는 서비스 계정 JSON을 저장해 주세요.',
    translation_language_confirmation: '원문 언어를 확신할 수 없어요. 원문을 확인한 뒤 번역을 시작해 주세요.',
    translation_same_language: '원문과 번역 언어가 같아 번역하지 않았어요.',
    translation_rate_limit: '제공자의 할당량이 부족해요. 잠시 후 다시 시도하거나 한도를 확인해 주세요.',
    translation_auth: '키 또는 모델 사용 권한을 확인해 주세요.',
    translation_invalid_output: '번역 결과의 문단 구성이 맞지 않아요. 다시 시도해 주세요.',
    translation_timeout: '번역 응답을 기다리다 시간이 초과됐어요. 나누는 크기를 줄여 보세요.',
    translation_source_changed: '원문이 바뀌었거나 삭제됐어요. 작품을 다시 열어 주세요.',
    translation_conflict: '다른 화면에서 설정을 바꿨어요. 다시 불러온 후 저장해 주세요.',
    translation_invalid_settings: '입력값과 허용 범위를 확인해 주세요.',
    translation_invalid_endpoint: '인증 정보가 없는 HTTPS API 주소를 입력해 주세요.',
    translation_busy: '대기 중인 번역이 많아요. 기존 작업이 끝난 후 다시 시도해 주세요.',
  };
  return messages[code ?? ''] ?? '번역을 완료하지 못했어요. 연결과 번역 설정을 확인한 뒤 다시 시도해 주세요.';
}

/** Title projections are keyed by exact original text, never a renamed source/library record. */
export interface TranslatedTitle {
  original: string;
  translated?: string;
  status: TranslationStatus | 'original';
}
export interface TitleTranslationResponse {
  titles: TranslatedTitle[];
}
/** Short titles cannot use the chapter detector's minimum text length. Ambiguous titles
 * are left to the title prompt, which must preserve text already in the target language. */
export function shouldTranslateTitle(title: string, targetLanguage: string): boolean {
  if (!title.trim() || title.length > 500) return false;
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return false;
  const target = targetLanguage.toLowerCase().split('-')[0];
  const count = (pattern: RegExp) => title.match(pattern)?.length ?? 0;
  if (target === 'ko' && count(/\p{Script=Hangul}/gu) / letters > 0.35) return false;
  if (target === 'ja' && count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) / letters > 0.12) return false;
  if (target === 'zh' && count(/\p{Script=Han}/gu) / letters > 0.55) return false;
  return true;
}
