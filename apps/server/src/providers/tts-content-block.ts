import { GeminiAudioResponseError } from './gemini-audio-response.js';

export const CONTENT_BLOCK_MESSAGE = '음성 제공자가 콘텐츠 제한으로 이 구간의 생성을 거절했어요.';
export class TTSContentBlockedError extends Error {
  readonly code = 'tts_content_blocked';
  constructor(readonly reason: 'content_policy_violation' | 'content_filter') {
    super(CONTENT_BLOCK_MESSAGE);
  }
}
/** Only typed provider refusals qualify; never infer a policy decision from text or a 4xx status. */
export function ttsContentBlockReason(error: unknown): string | undefined {
  if (error instanceof TTSContentBlockedError) return error.reason;
  if (
    error instanceof GeminiAudioResponseError &&
    ['provider_finish_reason', 'provider_prompt_block'].includes(error.reason) &&
    ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(error.completion ?? '')
  )
    return error.completion;
}
