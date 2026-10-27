import type { SpeakerEngine, SpeakerEngineInput } from '../../providers/speaker-engine';
import {
  inspectVertexJson,
  vertexBaseUrl,
  vertexLocationValid,
  vertexProjectValid,
} from '../../providers/vertex-connection';

export type Protocol = SpeakerEngineInput['protocol'];
export type Reasoning = NonNullable<SpeakerEngineInput['reasoning']>;
export type TokenLimitParameter = NonNullable<SpeakerEngineInput['tokenLimitParameter']>;

/** The analysis service usually runs as its own container next to BOAA. */
export const DEFAULT_SPEAKER_ENGINE_URL = 'http://speaker-engine:8095';

export const SPEAKER_ENGINE_OUTPUT = { min: 1024, max: 32768, default: 24576 } as const;
/** Total concurrent analysis requests (attribution + identity); 1 keeps the paid request rate unchanged until raised. */
export const SPEAKER_ANALYSIS_CONCURRENCY = { min: 1, max: 8 } as const;
export const SPEAKER_RATE_LIMIT_RETRIES = { min: 0, max: 100 } as const;

/** Field lengths the server accepts. */
export const SPEAKER_ENGINE_FIELD_MAX = {
  name: 80,
  url: 2048,
  modelId: 200,
  apiKey: 4096,
  engineToken: 4096,
} as const;

export const PROTOCOL_HINT: Record<Protocol, { url: string; model: string; note: string }> = {
  openai: {
    url: 'https://api.example.com/v1',
    model: '서비스나 서버의 모델 ID',
    note: 'OpenAI 호환 채팅 API 주소예요. 클라우드 서비스와 같은 네트워크의 로컬 모델 서버 모두 쓸 수 있어요.',
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com',
    model: 'Gemini 모델 ID',
    note: 'Gemini API 주소와 API 키를 넣어요.',
  },
  vertex: {
    url: '',
    model: 'Vertex AI 모델 ID',
    note: 'Google Cloud 서비스 계정 JSON으로 연결해요. 프로젝트와 리전에 맞는 주소는 자동으로 사용해요.',
  },
};

export interface Draft {
  purpose: 'analysis' | 'casting';
  name: string;
  protocol: Protocol;
  url: string;
  modelId: string;
  /** Typed secrets live only in component state; never written to browser storage. */
  apiKey: string;
  clearKey: boolean;
  serviceAccountJson: string;
  projectId: string;
  location: string;
  engineUrl: string;
  engineToken: string;
  clearToken: boolean;
  maxOutputTokens: string;
  reasoning: Reasoning | '';
  pdfInput: boolean;
  /** OpenAI-compatible only: which request field carries the output limit. */
  tokenLimitParameter: TokenLimitParameter;
  analysisConcurrency: number;
  /** '' keeps retrying after 429; '0' stops at the first one. */
  rateLimitRetries: string;
  paid: boolean;
  enabled: boolean;
}

export const emptyDraft = (): Draft => ({
  purpose: 'analysis',
  name: '',
  protocol: 'openai',
  url: '',
  modelId: '',
  apiKey: '',
  clearKey: false,
  serviceAccountJson: '',
  projectId: '',
  location: 'global',
  engineUrl: DEFAULT_SPEAKER_ENGINE_URL,
  engineToken: '',
  clearToken: false,
  maxOutputTokens: String(SPEAKER_ENGINE_OUTPUT.default),
  reasoning: '',
  pdfInput: false,
  tokenLimitParameter: 'max_tokens',
  analysisConcurrency: 1,
  rateLimitRetries: '',
  // A local model is free, but assuming a charge keeps the consent step until the person says otherwise.
  paid: true,
  enabled: true,
});

export const draftFrom = (engine: SpeakerEngine): Draft => ({
  purpose: engine.purpose ?? 'analysis',
  name: engine.name,
  protocol: engine.protocol,
  url: engine.url,
  modelId: engine.modelId,
  apiKey: '',
  clearKey: false,
  serviceAccountJson: '',
  projectId: engine.projectId ?? '',
  location: engine.location ?? 'global',
  engineUrl: engine.engineUrl,
  engineToken: '',
  clearToken: false,
  maxOutputTokens: String(engine.maxOutputTokens),
  reasoning: engine.reasoning ?? '',
  pdfInput: engine.inputFormat === 'pdf',
  tokenLimitParameter: engine.tokenLimitParameter ?? 'max_tokens',
  analysisConcurrency: engine.analysisConcurrency ?? 1,
  rateLimitRetries: engine.rateLimitRetries === undefined ? '' : String(engine.rateLimitRetries),
  paid: engine.paid,
  enabled: engine.enabled,
});

const parseUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

export const hostName = (value: string) => parseUrl(value)?.host ?? '';

const movedOrigin = (next: string, saved: string) => {
  const url = parseUrl(next);
  return Boolean(url && url.origin !== parseUrl(saved)?.origin);
};

/**
 * A stored secret is never sent to a different origin: once its address moves, the person must type a new one or
 * clear it explicitly. The model key follows `url`; the service token follows `engineUrl`.
 */
export function secretDecisions(draft: Draft, current?: SpeakerEngine) {
  return {
    apiKey: Boolean(
      draft.protocol !== 'vertex' &&
      current?.hasApiKey &&
      !draft.apiKey.trim() &&
      !draft.clearKey &&
      movedOrigin(draft.url, current.url),
    ),
    engineToken: Boolean(
      current?.hasEngineToken &&
      !draft.engineToken.trim() &&
      !draft.clearToken &&
      movedOrigin(draft.engineUrl, current.engineUrl),
    ),
  };
}

const outputTokens = (value: string) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= SPEAKER_ENGINE_OUTPUT.min && number <= SPEAKER_ENGINE_OUTPUT.max
    ? number
    : undefined;
};

const retryLimit = (value: string) => {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) &&
    number >= SPEAKER_RATE_LIMIT_RETRIES.min &&
    number <= SPEAKER_RATE_LIMIT_RETRIES.max
    ? number
    : undefined;
};

// Omitted keeps the stored secret; '' clears it.
const secret = (typed: string, clear: boolean) => (typed.trim() ? typed.trim() : clear ? '' : undefined);

/** What the draft would send, plus the first reason checking or saving cannot go ahead. */
export function readDraft(draft: Draft, current?: SpeakerEngine) {
  const vertex = draft.protocol === 'vertex';
  let vertexProblem: string | undefined;
  let vertexUrl = '';
  if (vertex) {
    const inspected = draft.serviceAccountJson ? inspectVertexJson(draft.serviceAccountJson) : undefined;
    vertexProblem =
      inspected && 'error' in inspected
        ? inspected.error
        : !draft.serviceAccountJson && !current?.hasServiceAccount
          ? '서비스 계정 JSON 키 파일을 골라 주세요.'
          : !vertexProjectValid(draft.projectId.trim())
            ? '프로젝트 ID를 확인해 주세요.'
            : !vertexLocationValid(draft.location.trim())
              ? '리전을 확인해 주세요. 예: global, us-central1'
              : undefined;
    if (vertexProjectValid(draft.projectId.trim()) && vertexLocationValid(draft.location.trim()))
      vertexUrl = vertexBaseUrl(draft.projectId.trim(), draft.location.trim());
  }
  const apiKey = secret(draft.apiKey, draft.clearKey);
  const engineToken = secret(draft.engineToken, draft.clearToken);
  const maxOutputTokens = outputTokens(draft.maxOutputTokens);
  const analysis = draft.purpose === 'analysis';
  // null = no cap (field left empty); undefined = not a valid count.
  const retries = retryLimit(draft.rateLimitRetries);
  const concurrencyValid =
    Number.isInteger(draft.analysisConcurrency) &&
    draft.analysisConcurrency >= SPEAKER_ANALYSIS_CONCURRENCY.min &&
    draft.analysisConcurrency <= SPEAKER_ANALYSIS_CONCURRENCY.max;
  const input: SpeakerEngineInput = {
    ...(draft.purpose === 'casting' || current?.purpose ? { purpose: draft.purpose } : {}),
    name: draft.name.trim() || draft.modelId.trim() || hostName(draft.url) || '분석 모델',
    engineUrl: draft.engineUrl.trim(),
    ...(engineToken !== undefined ? { engineToken } : {}),
    protocol: draft.protocol,
    url: vertex ? vertexUrl : draft.url.trim(),
    ...(vertex
      ? {
          projectId: draft.projectId.trim(),
          location: draft.location.trim(),
          ...(draft.serviceAccountJson ? { serviceAccountJson: draft.serviceAccountJson } : {}),
        }
      : apiKey !== undefined
        ? { apiKey }
        : {}),
    modelId: draft.modelId.trim(),
    ...(draft.protocol !== 'openai' && draft.pdfInput ? { inputFormat: 'pdf' as const } : {}),
    maxOutputTokens: maxOutputTokens ?? SPEAKER_ENGINE_OUTPUT.default,
    ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
    // The compatible default is left implicit, so opening and saving an older model changes nothing.
    ...(draft.protocol === 'openai' &&
    (draft.tokenLimitParameter !== 'max_tokens' || current?.tokenLimitParameter !== undefined)
      ? { tokenLimitParameter: draft.tokenLimitParameter }
      : {}),
    // Execution limits apply to analysis only. Like the token field, an older model's implicit 1 stays implicit.
    ...(analysis && (draft.analysisConcurrency !== 1 || current?.analysisConcurrency !== undefined)
      ? { analysisConcurrency: draft.analysisConcurrency }
      : {}),
    ...(analysis && typeof retries === 'number' ? { rateLimitRetries: retries } : {}),
    paid: draft.paid,
    enabled: draft.enabled,
  };
  const decisions = secretDecisions(draft, current);
  const probeProblem =
    vertexProblem ??
    (!vertex && !parseUrl(draft.url)
      ? '모델 API 주소는 http:// 또는 https://로 시작해야 해요.'
      : !parseUrl(draft.engineUrl)
        ? '분석 서비스 주소는 http:// 또는 https://로 시작해야 해요.'
        : decisions.apiKey
          ? '모델 API 주소가 바뀌어 저장된 API 키를 쓸 수 없어요. 새 키를 넣거나 저장된 키 지우기를 고르세요.'
          : decisions.engineToken
            ? '분석 서비스 주소가 바뀌어 저장된 토큰을 쓸 수 없어요. 새 토큰을 넣거나 저장된 토큰 지우기를 고르세요.'
            : undefined);
  const saveProblem =
    probeProblem ??
    (!input.modelId
      ? '모델 ID를 넣어 주세요.'
      : !maxOutputTokens
        ? `최대 출력 토큰은 ${SPEAKER_ENGINE_OUTPUT.min}~${SPEAKER_ENGINE_OUTPUT.max} 사이 정수로 넣어 주세요.`
        : analysis && !concurrencyValid
          ? `동시 분석 요청 수는 ${SPEAKER_ANALYSIS_CONCURRENCY.min}~${SPEAKER_ANALYSIS_CONCURRENCY.max}개 중에서 골라 주세요.`
          : analysis && retries === undefined
            ? `요청 제한 재시도 횟수는 ${SPEAKER_RATE_LIMIT_RETRIES.min}~${SPEAKER_RATE_LIMIT_RETRIES.max} 사이 정수로 넣거나, 계속 재시도하려면 비워 두세요.`
            : undefined);
  return { input, decisions, probeProblem, saveProblem };
}
