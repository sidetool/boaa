import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { TTSConnectionInput } from '../../../../src/providers/tts-connections';

export class TTSConnectionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
export function connectionError(message: string, statusCode = 400): TTSConnectionError {
  return new TTSConnectionError(message, statusCode);
}

function text(value: unknown, label: string, max: number, optional = false): string {
  if (value === undefined && optional) return '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw connectionError(`${label}을 확인해 주세요.`);
  const result = value.trim();
  if (!result && !optional) throw connectionError(`${label}을 입력해 주세요.`);
  return result;
}

/** Called only on the administrator route. The exact saved origin authorizes egress. */
export function normalizeTTSConnection(value: unknown, probe = false): TTSConnectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw connectionError('연결 정보를 확인해 주세요.');
  const row = value as Record<string, unknown>;
  if (row.protocol !== 'local' && row.protocol !== 'openai') throw connectionError('연결 방식을 선택해 주세요.');
  const protocol = row.protocol;
  const rawUrl = text(row.url, '서버 주소', 2048);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw connectionError('http 또는 https 서버 주소를 입력해 주세요.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw connectionError('주소에는 로그인 정보·쿼리·해시를 넣을 수 없어요. API 키는 별도 칸에 입력해 주세요.');
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname =
    protocol === 'openai'
      ? pathname.endsWith('/audio/speech')
        ? pathname
        : (pathname || '/v1') + '/audio/speech'
      : pathname.endsWith('/synthesize')
        ? pathname
        : pathname + '/synthesize';
  const integer = (key: string, max: number) => {
    const v = row[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)
      throw connectionError('요청 크기 제한을 확인해 주세요.');
    return v;
  };
  if (!Array.isArray(row.voices) || row.voices.length > 64)
    throw connectionError('목소리는 최대 64개까지 저장할 수 있어요.');
  const voices = row.voices.map((v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw connectionError('목소리 정보를 확인해 주세요.');
    const voice = v as Record<string, unknown>;
    const id = text(voice.id, '목소리 ID', 160);
    try {
      if (encodeURIComponent(id).length > 464) throw new Error();
    } catch {
      throw connectionError('목소리 ID가 너무 길거나 올바르지 않아요.');
    }
    return {
      id,
      label: text(voice.label, '목소리 이름', 120, true) || id,
      lang: text(voice.lang, '언어', 40, true) || 'und',
    };
  });
  if (new Set(voices.map((v) => v.id)).size !== voices.length) throw connectionError('중복된 목소리 ID를 지워 주세요.');
  if (!probe && !voices.length) throw connectionError('목소리를 불러오거나 목소리 ID를 하나 이상 입력해 주세요.');
  if (typeof row.enabled !== 'boolean' || typeof row.paid !== 'boolean')
    throw connectionError('연결 설정을 확인해 주세요.');
  return {
    name: text(row.name, '이름', 80, probe),
    protocol,
    url: url.toString(),
    modelId: text(row.modelId, '모델 ID', 200, probe),
    ...(row.apiKey === undefined ? {} : { apiKey: text(row.apiKey, 'API 키', 4096, true) }),
    voices,
    maxInputCharacters: integer('maxInputCharacters', 20_000),
    maxInputSegments: integer('maxInputSegments', 32),
    paid: row.paid,
    enabled: row.enabled,
  };
}

export function ttsConnectionModelRevision(input: TTSConnectionInput): string {
  // Names, credentials, enabled state and discovery/catalog changes cannot alter recorded model identity.
  return structuredIntegrityHash({ protocol: input.protocol, url: input.url, modelId: input.modelId });
}
