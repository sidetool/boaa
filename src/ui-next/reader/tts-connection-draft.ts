import type { TTSConnection, TTSConnectionInput, TTSConnectionVoice } from '../../providers/tts-connections';

export type Protocol = TTSConnectionInput['protocol'];

export const TTS_CONNECTION_LIMITS = {
  defaultCharacters: 1000,
  defaultSegments: 8,
  maxCharacters: 20000,
  maxSegments: 32,
  maxVoices: 64,
} as const;

/** Field lengths the server accepts. */
export const TTS_CONNECTION_FIELD_MAX = { name: 80, url: 2048, modelId: 200, apiKey: 4096 } as const;

export const PROTOCOL_HINT: Record<Protocol, { url: string; note: string }> = {
  local: {
    url: 'http://192.168.0.10:8080',
    note: '로컬 TTS 서버의 기본 주소나 /synthesize 주소를 넣어요. 서버가 돌아가는 PC가 켜져 있고 BOAA 서버에서 접속할 수 있어야 해요.',
  },
  openai: {
    url: 'https://example.com/v1',
    note: 'OpenAI 호환 음성 합성(TTS) 주소예요. /v1 또는 /v1/audio/speech 주소를 넣어요. 채팅 API 주소는 쓸 수 없어요.',
  },
};

export interface Draft {
  name: string;
  protocol: Protocol;
  url: string;
  modelId: string;
  /** Typed key, held only in component state; never written to browser storage. */
  apiKey: string;
  clearKey: boolean;
  voices: string;
  maxInputCharacters: string;
  maxInputSegments: string;
  paid: boolean;
  /** Once the person sets 유료 themselves, switching protocol no longer changes it. */
  paidTouched: boolean;
  enabled: boolean;
}

export const emptyDraft = (): Draft => ({
  name: '',
  protocol: 'local',
  url: '',
  modelId: '',
  apiKey: '',
  clearKey: false,
  voices: '',
  maxInputCharacters: String(TTS_CONNECTION_LIMITS.defaultCharacters),
  maxInputSegments: String(TTS_CONNECTION_LIMITS.defaultSegments),
  paid: false,
  paidTouched: false,
  enabled: true,
});

export const draftFrom = (connection: TTSConnection): Draft => ({
  name: connection.name,
  protocol: connection.protocol,
  url: connection.url,
  modelId: connection.modelId,
  apiKey: '',
  clearKey: false,
  voices: formatVoices(connection.voices),
  maxInputCharacters: String(connection.maxInputCharacters),
  maxInputSegments: String(connection.maxInputSegments),
  paid: connection.paid,
  paidTouched: true,
  enabled: connection.enabled,
});

/** One voice per line: `id, 표시 이름, 언어`. Only the id is required. */
export function parseVoices(text: string): { voices: TTSConnectionVoice[]; error?: string } {
  const voices: TTSConnectionVoice[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [id = '', label = '', lang = ''] = line.split(',').map((part) => part.trim());
    if (!id) return { voices, error: `목소리 ID가 빈 줄이 있어요: ${line.trim()}` };
    if (seen.has(id)) return { voices, error: `같은 목소리 ID가 두 번 있어요: ${id}` };
    seen.add(id);
    voices.push(lang ? { id, label: label || id, lang } : { id, label: label || id });
  }
  if (voices.length > TTS_CONNECTION_LIMITS.maxVoices)
    return { voices, error: `목소리는 ${TTS_CONNECTION_LIMITS.maxVoices}개까지 넣을 수 있어요.` };
  return { voices };
}

export function formatVoices(voices: readonly TTSConnectionVoice[]) {
  return voices
    .map((voice) =>
      [voice.id, voice.label !== voice.id || voice.lang ? voice.label : '', voice.lang ?? '']
        .join(', ')
        .replace(/(, )+$/, ''),
    )
    .join('\n');
}

const parseUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

export const hostName = (value: string) => parseUrl(value)?.host ?? '';

const limit = (value: string, max: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : undefined;
};

/**
 * The stored key is never sent to a different origin: once the address moves, the person must type a new key or
 * clear it explicitly.
 */
export function keyDecisionNeeded(draft: Draft, current?: TTSConnection) {
  if (!current?.hasApiKey || draft.apiKey.trim() || draft.clearKey) return false;
  const next = parseUrl(draft.url);
  return Boolean(next && next.origin !== parseUrl(current.url)?.origin);
}

/** What the draft would send, plus the first reason probing or saving cannot go ahead. */
export function readDraft(draft: Draft, current?: TTSConnection) {
  const parsed = parseVoices(draft.voices);
  const maxInputCharacters = limit(draft.maxInputCharacters, TTS_CONNECTION_LIMITS.maxCharacters);
  const maxInputSegments = limit(draft.maxInputSegments, TTS_CONNECTION_LIMITS.maxSegments);
  // Omitting the key on edit keeps the stored one; '' clears it.
  const apiKey = draft.apiKey.trim() ? draft.apiKey.trim() : draft.clearKey ? '' : undefined;
  const input: TTSConnectionInput = {
    name: draft.name.trim() || hostName(draft.url) || 'TTS 서버',
    protocol: draft.protocol,
    url: draft.url.trim(),
    modelId: draft.modelId.trim(),
    ...(apiKey !== undefined ? { apiKey } : {}),
    voices: parsed.voices,
    maxInputCharacters: maxInputCharacters ?? TTS_CONNECTION_LIMITS.defaultCharacters,
    maxInputSegments: maxInputSegments ?? TTS_CONNECTION_LIMITS.defaultSegments,
    paid: draft.paid,
    enabled: draft.enabled,
  };
  const probeProblem = !parseUrl(draft.url)
    ? 'http:// 또는 https://로 시작하는 주소를 넣어 주세요.'
    : keyDecisionNeeded(draft, current)
      ? '주소가 바뀌어 저장된 API 키를 쓸 수 없어요. 새 키를 넣거나 저장된 키 지우기를 고르세요.'
      : undefined;
  const saveProblem =
    probeProblem ??
    (!input.modelId
      ? '모델 ID를 넣어 주세요.'
      : parsed.error
        ? parsed.error
        : parsed.voices.length === 0
          ? '목소리를 하나 이상 넣어 주세요.'
          : !maxInputCharacters
            ? `한 번에 보낼 최대 글자 수는 1~${TTS_CONNECTION_LIMITS.maxCharacters} 사이로 넣어 주세요.`
            : !maxInputSegments
              ? `나눠 보낼 최대 구간 수는 1~${TTS_CONNECTION_LIMITS.maxSegments} 사이로 넣어 주세요.`
              : undefined);
  return { input, parsed, probeProblem, saveProblem };
}
