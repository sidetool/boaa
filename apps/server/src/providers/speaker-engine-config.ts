import type { SpeakerEngineInput } from '../../../../src/providers/speaker-engine';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import { connectionError } from './tts-connection-config.js';
export function speakerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw connectionError('서버 주소를 확인해 주세요.');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw connectionError('http 또는 https 주소를 입력해 주세요.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw connectionError('주소의 로그인 정보·쿼리·해시를 제거해 주세요.');
  return u.toString().replace(/\/+$/, '');
}
function text(value: unknown, max: number, required = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    (required && !value.trim())
  )
    throw connectionError('입력한 설정을 확인해 주세요.');
  return value.trim();
}
export function normalizeSpeakerEngine(input: unknown, probe = false): SpeakerEngineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw connectionError('분석 연결 설정을 확인해 주세요.');
  const v = input as SpeakerEngineInput;
  if (v.purpose !== undefined && !['analysis', 'casting'].includes(v.purpose))
    throw connectionError('모델 용도를 확인해 주세요.');
  if (v.tokenLimitParameter !== undefined && !['max_tokens', 'max_completion_tokens'].includes(v.tokenLimitParameter))
    throw connectionError('출력 한도 방식을 확인해 주세요.');
  if (
    !['openai', 'gemini'].includes(v.protocol) ||
    typeof v.enabled !== 'boolean' ||
    typeof v.paid !== 'boolean' ||
    !Number.isInteger(v.maxOutputTokens) ||
    v.maxOutputTokens < 1024 ||
    v.maxOutputTokens > 32768 ||
    (v.reasoning !== undefined && !['low', 'medium', 'high'].includes(v.reasoning))
  )
    throw connectionError('모델 설정을 확인해 주세요.');
  let url = speakerUrl(v.url);
  url = url.replace(/\/chat\/completions$/, '');
  const u = new URL(url);
  if (u.pathname === '/' || !u.pathname) url += v.protocol === 'openai' ? '/v1' : '/v1beta';
  return {
    ...(v.purpose ? { purpose: v.purpose } : {}),
    name: text(v.name, 80) || u.hostname,
    engineUrl: speakerUrl(v.engineUrl),
    protocol: v.protocol,
    url,
    modelId: text(v.modelId, 200, !probe),
    maxOutputTokens: v.maxOutputTokens,
    tokenLimitParameter: v.tokenLimitParameter,
    reasoning: v.reasoning,
    enabled: v.enabled,
    paid: v.paid,
    ...(v.apiKey !== undefined ? { apiKey: text(v.apiKey, 4096) } : {}),
    ...(v.engineToken !== undefined ? { engineToken: text(v.engineToken, 4096) } : {}),
  };
}
export function castingRevision(v: SpeakerEngineInput) {
  return structuredIntegrityHash({
    protocol: v.protocol,
    url: v.url,
    modelId: v.modelId,
    maxOutputTokens: v.maxOutputTokens,
    tokenLimitParameter: v.tokenLimitParameter ?? 'max_tokens',
    reasoning: v.reasoning,
  });
}
export function speakerRevision(v: SpeakerEngineInput) {
  return structuredIntegrityHash({
    engineUrl: v.engineUrl,
    protocol: v.protocol,
    url: v.url,
    modelId: v.modelId,
    maxOutputTokens: v.maxOutputTokens,
    tokenLimitParameter: v.tokenLimitParameter ?? 'max_tokens',
    reasoning: v.reasoning,
  });
}
