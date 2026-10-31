/** Only fixed diagnostic codes leave the adapter; never retain audio or source text in errors. */
export const INCOMPLETE_AUDIO_MESSAGE =
  '이 구간의 음성 응답이 완전하지 않아 저장하지 못했어요. 이미 만든 음성은 남아 있어요.';

export class GeminiAudioResponseError extends Error {
  readonly code = 'tts_incomplete_audio';
  constructor(
    readonly reason: string,
    readonly completion?: string,
  ) {
    super(audioFailureMessage(reason, completion));
  }
}
const reasons = new Set([
  'empty_audio_part',
  'invalid_wav_header',
  'wav_length_mismatch',
  'wav_chunk_header',
  'wav_chunk_length',
  'wav_format',
  'wav_sample_alignment',
  'missing_audio',
  'mixed_audio_containers',
  'mixed_wav_formats',
  'mixed_pcm_formats',
  'unsupported_audio_format',
  'pcm_sample_alignment',
  'missing_candidate',
  'provider_finish_reason',
  'provider_status',
  'provider_prompt_block',
]);
const completions = new Set([
  'MAX_TOKENS',
  'SAFETY',
  'RECITATION',
  'OTHER',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'CONTINUATION',
  'in_progress',
  'incomplete',
  'failed',
  'cancelled',
  'requires_action',
  'missing',
  'unknown',
]);
/** Use the structured logger's existing safe keys; arbitrary provider strings remain excluded. */
export function geminiAudioDiagnostics(error: GeminiAudioResponseError) {
  return {
    errorCode: reasons.has(error.reason) ? error.reason : 'unknown',
    state:
      error.completion === undefined ? 'missing' : completions.has(error.completion) ? error.completion : 'unknown',
  };
}
function audioFailureMessage(reason: string, completion?: string): string {
  if (reason === 'provider_finish_reason' || reason === 'provider_prompt_block') {
    if (completion === 'MAX_TOKENS') return '음성 제공자의 출력 한도로 이 구간의 생성이 중단됐어요.';
    if (completion === 'RECITATION') return '음성 제공자의 인용 콘텐츠 제한으로 이 구간을 만들지 못했어요.';
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(completion ?? ''))
      return '음성 제공자의 콘텐츠 제한으로 이 구간을 만들지 못했어요.';
    if (reason === 'provider_prompt_block') return '음성 제공자가 이 구간의 입력을 거절했어요.';
    if (completion === 'missing') return '음성 응답의 완료 상태를 확인할 수 없어 저장하지 못했어요.';
  }
  if (reason === 'missing_audio' || reason === 'empty_audio_part')
    return '음성 제공자가 재생할 수 있는 음성을 보내지 않았어요.';
  if (reasons.has(reason) && !reason.startsWith('provider_') && reason !== 'missing_candidate')
    return '받은 음성 데이터의 형식이 올바르지 않아 저장하지 못했어요.';
  return INCOMPLETE_AUDIO_MESSAGE;
}
/** Old persisted messages incorrectly referred to live-listening settings, which cannot change saved jobs. */
export function savedAudioErrorMessage(message: string | null | undefined): string | undefined {
  if (
    message ===
    '음성 생성 응답이 늦어 중단되었습니다. 잠시 후 다시 재생하세요. 긴 문단은 문장 단위로 바꾸면 도움이 될 수 있습니다.'
  )
    return '음성 서비스의 응답이 늦어 작업이 멈췄어요. 이어 만들기를 누르면 미완료 구간부터 다시 시도해요.';
  if (
    message ===
      '음성 생성이 끝까지 완료되지 않았습니다. 읽던 묶음에서 다시 시도하거나 세부 청취 설정의 묶음 크기를 줄여 주세요.' ||
    message === '음성 생성이 끝까지 완료되지 않았습니다. 읽던 묶음에서 다시 시도하거나 묶음 크기를 줄여 주세요.'
  )
    return INCOMPLETE_AUDIO_MESSAGE;
  return message ?? undefined;
}
const incomplete = (reason: string, completion?: string) => new GeminiAudioResponseError(reason, completion);
const safeCompletion = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : value === undefined ? 'missing' : 'unknown';
interface AudioPart {
  buffer: Buffer;
  mimeType?: string;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function decode(value: unknown): Buffer | undefined {
  if (typeof value === 'string' && value.trim()) return Buffer.from(value, 'base64');
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
}
function collect(value: unknown): AudioPart[] {
  if (Array.isArray(value)) return value.flatMap(collect);
  const item = record(value);
  if (item.inlineData || item.inline_data) return collect(item.inlineData ?? item.inline_data);
  const mimeType = item.mimeType ?? item.mime_type;
  if ((typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('audio/')) || item.type === 'audio') {
    const buffer = decode(item.data);
    if (!buffer?.length) throw incomplete('empty_audio_part');
    return [{ buffer, mimeType: typeof mimeType === 'string' ? mimeType : undefined }];
  }
  return Object.values(item).flatMap(collect);
}
function wavParts(buffer: Buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    throw incomplete('invalid_wav_header');
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw incomplete('wav_length_mismatch');
  let format: Buffer | undefined;
  const data: Buffer[] = [];
  for (let offset = 12; offset < buffer.length;) {
    if (offset + 8 > buffer.length) throw incomplete('wav_chunk_header');
    const length = buffer.readUInt32LE(offset + 4),
      end = offset + 8 + length;
    if (end + (length % 2) > buffer.length) throw incomplete('wav_chunk_length');
    const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') format = buffer.subarray(offset + 8, end);
    if (type === 'data') data.push(buffer.subarray(offset + 8, end));
    offset = end + (length % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || !data.length) throw incomplete('wav_format');
  const pcm = Buffer.concat(data);
  const alignment = format.readUInt16LE(12);
  if (!pcm.length || !alignment || pcm.length % alignment) throw incomplete('wav_sample_alignment');
  return { format, data: pcm };
}
function merge(parts: AudioPart[]): AudioPart {
  if (!parts.length) throw incomplete('missing_audio');
  const first = parts[0];
  const isWav = (part: AudioPart) => part.buffer.toString('ascii', 0, 4) === 'RIFF';
  if (parts.some(isWav)) {
    if (!parts.every(isWav)) throw incomplete('mixed_audio_containers');
    const wavs = parts.map((p) => wavParts(p.buffer));
    if (wavs.some((w) => !w.format.equals(wavs[0].format))) throw incomplete('mixed_wav_formats');
    if (parts.length === 1) return { buffer: first.buffer, mimeType: 'audio/wav' };
    const fmt = wavs[0].format,
      data = Buffer.concat(wavs.map((w) => w.data));
    const padding = fmt.length % 2,
      header = Buffer.alloc(12 + 8 + fmt.length + padding + 8);
    header.write('RIFF');
    header.writeUInt32LE(header.length + data.length + (data.length % 2) - 8, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(fmt.length, 16);
    fmt.copy(header, 20);
    header.write('data', 20 + fmt.length + padding);
    header.writeUInt32LE(data.length, 24 + fmt.length + padding);
    return { buffer: Buffer.concat([header, data, Buffer.alloc(data.length % 2)]), mimeType: 'audio/wav' };
  }
  const mime = (first.mimeType ?? 'audio/pcm').toLowerCase();
  if (parts.some((p) => (p.mimeType ?? 'audio/pcm').toLowerCase() !== mime)) throw incomplete('mixed_pcm_formats');
  if (!/^audio\/(pcm|l16)(;|$)/.test(mime)) throw incomplete('unsupported_audio_format');
  const buffer = Buffer.concat(parts.map((p) => p.buffer));
  if (buffer.length % 2) throw incomplete('pcm_sample_alignment');
  return { buffer, mimeType: first.mimeType };
}
export function vertexAudioResponse(value: unknown): AudioPart {
  const body = record(value);
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    const feedback = record(body.promptFeedback ?? body.prompt_feedback);
    const block = feedback.blockReason ?? feedback.block_reason;
    if (block !== undefined && block !== 'BLOCK_REASON_UNSPECIFIED')
      throw incomplete(
        'provider_prompt_block',
        safeCompletion(block, ['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT']),
      );
    throw incomplete('missing_candidate');
  }
  const candidate = record(candidates[0]);
  const completion = candidate.finishReason ?? candidate.finish_reason;
  if (completion !== 'STOP')
    throw incomplete(
      'provider_finish_reason',
      safeCompletion(completion, [
        'MAX_TOKENS',
        'SAFETY',
        'RECITATION',
        'OTHER',
        'BLOCKLIST',
        'PROHIBITED_CONTENT',
        'SPII',
        'CONTINUATION',
      ]),
    );
  // Alternatives are not successive audio; never merge separate candidates or request echoes.
  return merge(collect(record(candidate.content).parts));
}
export function interactionAudioResponse(value: unknown): AudioPart {
  const body = record(value);
  if (body.status !== undefined && body.status !== 'completed')
    throw incomplete(
      'provider_status',
      safeCompletion(body.status, ['in_progress', 'incomplete', 'failed', 'cancelled', 'requires_action']),
    );
  const direct = record(body.output_audio ?? body.outputAudio);
  if (direct.data) return merge(collect({ ...direct, type: 'audio' }));
  return merge(collect(body.outputs ?? body.steps ?? body.output));
}
