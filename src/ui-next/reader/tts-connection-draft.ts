import {
  connectionSpeechModel,
  fishSpeechModel,
  type FishSpeechModel,
  type TTSConnection,
  type TTSConnectionInput,
  type TTSConnectionVoice,
} from '../../providers/tts-connections';

export type Protocol = TTSConnectionInput['protocol'];
export const PROTOCOLS: readonly Protocol[] = ['local', 'openai', 'fish', 'openrouter'];

export const TTS_CONNECTION_LIMITS = {
  defaultCharacters: 1000,
  defaultSegments: 8,
  maxCharacters: 20000,
  maxSegments: 32,
  maxVoices: 64,
} as const;

/** Field lengths the server accepts. */
export const TTS_CONNECTION_FIELD_MAX = { name: 80, url: 2048, modelId: 200, apiKey: 4096 } as const;

export const PROTOCOL_HINT: Record<
  Protocol,
  { label: string; tagline: string; url: string; note: string; defaultUrl?: string }
> = {
  local: {
    label: '로컬 서버',
    tagline: '내 PC·NAS',
    url: 'http://192.168.0.10:8080',
    note: '로컬 TTS 서버의 기본 주소나 /synthesize 주소를 넣어요. 서버가 돌아가는 PC가 켜져 있고 BOAA 서버에서 접속할 수 있어야 해요.',
  },
  openai: {
    label: 'OpenAI 호환',
    tagline: '/v1/audio/speech',
    url: 'https://example.com/v1',
    note: 'OpenAI 호환 음성 합성(TTS) 주소예요. /v1 또는 /v1/audio/speech 주소를 넣어요. 채팅 API 주소는 쓸 수 없어요.',
  },
  fish: {
    label: 'Fish Audio',
    tagline: 'S2.1 Pro · Drama 3',
    url: 'https://api.fish.audio',
    defaultUrl: 'https://api.fish.audio',
    note: 'Fish Audio API 키로 바로 연결해요. 목소리는 Fish Audio에서 고른 목소리의 ID를 넣어요.',
  },
  openrouter: {
    label: 'OpenRouter',
    tagline: 'Fish 등 음성 모델',
    url: 'https://openrouter.ai/api/v1',
    defaultUrl: 'https://openrouter.ai/api/v1',
    note: 'OpenRouter 키로 음성 모델을 써요. Fish Audio 모델은 장면 연기와 말투 지시까지, 다른 모델은 기본 낭독만 해요.',
  },
};

export const SPEECH_MODEL_LABEL: Record<FishSpeechModel, string> = {
  'fish-s2': 'Fish S2',
  'fish-drama': 'Fish Drama',
};

export interface ModelPreset {
  readonly id: string;
  readonly label: string;
  /** Only an exact, provider-published free model id; a relay's other names are never assumed free. */
  readonly free?: boolean;
}

/** Same order on both services, so switching between them keeps the chosen model. */
export const MODEL_PRESETS: Partial<Record<Protocol, readonly ModelPreset[]>> = {
  fish: [
    { id: 's2.1-pro', label: 'S2.1 Pro' },
    { id: 's2.1-pro-free', label: 'S2.1 Pro', free: true },
    { id: 'drama-3', label: 'Drama 3' },
  ],
  openrouter: [
    { id: 'fish-audio/s2.1-pro', label: 'S2.1 Pro' },
    { id: 'fish-audio/s2.1-pro-free:free', label: 'S2.1 Pro', free: true },
    { id: 'fish-audio/drama-3', label: 'Drama 3' },
  ],
};

/** The server accepts only these on the native Fish API, which bills unknown names as its paid default. */
export const FISH_DIRECT_MODELS = ['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'] as const;

const preset = (protocol: Protocol, modelId: string) =>
  MODEL_PRESETS[protocol]?.find((item) => item.id === modelId.trim());
const fishModel = (protocol: Protocol, modelId: string) =>
  protocol === 'fish'
    ? (FISH_DIRECT_MODELS as readonly string[]).includes(modelId.trim())
    : protocol === 'openrouter' && Boolean(preset(protocol, modelId));

export const knownFree = (protocol: Protocol, modelId: string) => Boolean(preset(protocol, modelId)?.free);
/** A Fish model this app knows to bill per use. */
export const knownPaid = (protocol: Protocol, modelId: string) =>
  fishModel(protocol, modelId) && !knownFree(protocol, modelId);
/** The 유료 default for a server nobody marked yet: only a local server or an exact free model starts off. */
const expectedPaid = (protocol: Protocol, modelId: string) => protocol !== 'local' && !knownFree(protocol, modelId);

export const modelLabel = (protocol: Protocol, modelId: string) => {
  const found = preset(protocol, modelId);
  return found ? `${found.label}${found.free ? ' 무료' : ''}` : modelId;
};

/** Hosted services need a key; local and OpenAI-compatible servers may run without one. */
export const keyRequired = (protocol: Protocol) => protocol === 'fish' || protocol === 'openrouter';
/** Family override for relay aliases; native Fish names are always recognised. */
export const speechModelEditable = (protocol: Protocol) => protocol === 'openai' || protocol === 'openrouter';
/** A recognised model name decides its own family; the override is only for names BOAA does not know. */
const aliasOverride = (draft: Pick<Draft, 'protocol' | 'modelId' | 'speechModel'>) =>
  speechModelEditable(draft.protocol) && !fishSpeechModel(draft.modelId.trim()) ? draft.speechModel : '';

export interface Draft {
  name: string;
  protocol: Protocol;
  url: string;
  modelId: string;
  /** '' = decided from the model ID. */
  speechModel: FishSpeechModel | '';
  /** Typed key, held only in component state; never written to browser storage. */
  apiKey: string;
  clearKey: boolean;
  voices: string;
  maxInputCharacters: string;
  maxInputSegments: string;
  paid: boolean;
  /** Once the person sets 유료 themselves, only a move onto a known paid Fish model turns it back on. */
  paidTouched: boolean;
  enabled: boolean;
}

export const emptyDraft = (): Draft => ({
  name: '',
  protocol: 'local',
  url: '',
  modelId: '',
  speechModel: '',
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
  speechModel: connection.speechModel ?? '',
  apiKey: '',
  clearKey: false,
  voices: formatVoices(connection.voices),
  maxInputCharacters: String(connection.maxInputCharacters),
  maxInputSegments: String(connection.maxInputSegments),
  paid: connection.paid,
  paidTouched: true,
  enabled: connection.enabled,
});

type Target = Partial<Pick<Draft, 'protocol' | 'url' | 'modelId'>>;

/**
 * Applies a service or model change with its 유료 consequence. An untouched mark follows the known price; a mark
 * the person turned off for one model comes back on when they move to a Fish model known to bill.
 */
export function retarget(draft: Draft, next: Target): Draft {
  const moved = { ...draft, ...next };
  // Moving onto a preset or recognised name drops an override chosen for an earlier alias.
  const merged =
    next.modelId !== undefined && fishSpeechModel(moved.modelId.trim())
      ? { ...moved, speechModel: '' as const }
      : moved;
  if (!merged.paidTouched) return { ...merged, paid: expectedPaid(merged.protocol, merged.modelId) };
  return knownPaid(merged.protocol, merged.modelId) && !knownPaid(draft.protocol, draft.modelId)
    ? { ...merged, paid: true }
    : merged;
}

/** A preset address or model of the old service follows to the new one; anything typed stays as it is. */
export function switchProtocol(draft: Draft, protocol: Protocol): Draft {
  const presetUrl = !draft.url.trim() || PROTOCOLS.some((p) => PROTOCOL_HINT[p].defaultUrl === draft.url.trim());
  const presetIndex = MODEL_PRESETS[draft.protocol]?.findIndex((item) => item.id === draft.modelId.trim()) ?? -1;
  const next = retarget(draft, {
    protocol,
    ...(presetUrl ? { url: PROTOCOL_HINT[protocol].defaultUrl ?? '' } : {}),
    ...(presetIndex >= 0 ? { modelId: MODEL_PRESETS[protocol]?.[presetIndex]?.id ?? '' } : {}),
  });
  // A key typed for one service never follows the address to another.
  return parseUrl(next.url)?.origin !== parseUrl(draft.url)?.origin ? { ...next, apiKey: '' } : next;
}

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
  const speechModel = aliasOverride(draft) || undefined;
  const input: TTSConnectionInput = {
    name: draft.name.trim() || hostName(draft.url) || PROTOCOL_HINT[draft.protocol].label,
    protocol: draft.protocol,
    ...(speechModel ? { speechModel } : {}),
    url: draft.url.trim(),
    modelId: draft.modelId.trim(),
    ...(apiKey !== undefined ? { apiKey } : {}),
    voices: parsed.voices,
    maxInputCharacters: maxInputCharacters ?? TTS_CONNECTION_LIMITS.defaultCharacters,
    maxInputSegments: maxInputSegments ?? TTS_CONNECTION_LIMITS.defaultSegments,
    paid: draft.paid,
    enabled: draft.enabled,
  };
  const keyNeeded = keyDecisionNeeded(draft, current);
  const hasKey = Boolean(draft.apiKey.trim() || (current?.hasApiKey && !draft.clearKey && !keyNeeded));
  const probeProblem = !parseUrl(draft.url)
    ? 'http:// 또는 https://로 시작하는 주소를 넣어 주세요.'
    : keyNeeded
      ? '주소가 바뀌어 저장된 API 키를 쓸 수 없어요. 새 키를 넣거나 저장된 키 지우기를 고르세요.'
      : keyRequired(draft.protocol) && !hasKey
        ? `${PROTOCOL_HINT[draft.protocol].label} API 키를 넣어 주세요.`
        : undefined;
  const saveProblem =
    probeProblem ??
    (!input.modelId
      ? '모델 ID를 넣어 주세요.'
      : draft.protocol === 'fish' && !fishModel('fish', input.modelId)
        ? `Fish Audio 모델 ID는 ${FISH_DIRECT_MODELS.join(', ')} 중 하나예요.`
        : parsed.error
          ? parsed.error
          : parsed.voices.length === 0
            ? '목소리를 하나 이상 넣어 주세요.'
            : !maxInputCharacters
              ? `한 번에 보낼 최대 글자 수는 1~${TTS_CONNECTION_LIMITS.maxCharacters} 사이로 넣어 주세요.`
              : !maxInputSegments
                ? `나눠 보낼 최대 구간 수는 1~${TTS_CONNECTION_LIMITS.maxSegments} 사이로 넣어 주세요.`
                : undefined);
  return { input, parsed, probeProblem, saveProblem, speechModel: connectionSpeechModel(input) };
}
