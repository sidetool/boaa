import { useId, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import {
  isGeminiVoiceDesignModel,
  type SpeakerCastingOptions,
  type VoiceDesignProvider,
} from '../../providers/voice-library';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import { isGeminiActingModel } from '../../providers/tts-performance';
import { cx } from '../components/primitives';
import './voice-library.css';

export type CastingMode = 'order' | 'pick' | 'create';
export const DESIGN_BUDGETS = [1, 2, 3, 4, 5, 6, 7, 8];
const MIN_BUDGET = DESIGN_BUDGETS[0]!;
const MAX_BUDGET = DESIGN_BUDGETS[DESIGN_BUDGETS.length - 1]!;
/** Saved choices without design may hold 0; creating needs 1–8, so 0 is never shown or sent as a working limit. */
export const validBudget = (n?: number) => DESIGN_BUDGETS.includes(n ?? 0);
/** No model: order. A model alone picks from the list; with natural design it creates a voice per character. */
export const castingMode = (v?: SpeakerCastingOptions): CastingMode =>
  !v?.engineId ? 'order' : v.autoDesign && v.designMode === 'characters' ? 'create' : 'pick';
/** Product scope: only exact Gemini 3.8 Flash TTS connections may create voices, whatever else the server lists. */
export const voiceDesigners = (designers: readonly VoiceDesignProvider[] = []) =>
  designers.filter((d) => isGeminiVoiceDesignModel(d.modelId));
/**
 * Voice creation belongs to the connection that reads the book: it is offered only while the narrator
 * itself is a Gemini 3.8 Flash TTS voice, and new voices are made on that same connection.
 */
export const flashDesigner = (voice: PlainTTSVoice | undefined, designers: readonly VoiceDesignProvider[] = []) =>
  voice && isGeminiVoiceDesignModel(voice.modelId ?? voice.model?.modelId)
    ? voiceDesigners(designers).find((d) => d.id === voice.providerId)
    : undefined;

/**
 * Request batching follows what the catalog says the voice supports; older catalogs without the flag still batch
 * Gemini 3.8 Flash / Flash-Lite TTS voices. Other voices are always made one span at a time.
 */
export const batchable = (voice?: PlainTTSVoice) =>
  voice?.batchAudioSupported ?? isGeminiActingModel(voice?.modelId ?? voice?.model?.modelId);

/** Opt-in: fewer requests, at the cost of approximate in-batch position and no per-paragraph files. */
export function BatchAudioToggle({
  checked,
  partial,
  disabled,
  onChange,
}: {
  checked: boolean;
  /** Some voices in this job cannot be batched. */
  partial: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="un-book-ack un-cast-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        이어지는 대사 묶어 만들기
        <small className="un-book-note">
          같은 인물이 같은 말투로 이어 말하는 부분을 한 번에 만들어 요청이 줄어요. 묶인 부분은 읽는 위치가 대략
          표시되고, 구간별 음성은 따로 남지 않아요.
          {partial ? ' 묶기를 지원하는 목소리만 묶여요.' : ''}
        </small>
      </span>
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  body: ReactNode;
  tag?: string;
  /** Why the option cannot be picked; shown only while it is disabled. */
  reason?: ReactNode;
  disabled?: boolean;
}

/** Radio cards: every choice stays visible together, unlike a native select on a phone. */
export function ChoiceCards<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  disabled?: boolean;
  onChange(value: T): void;
}) {
  const name = useId();
  return (
    <div className="un-choice-group" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        const off = disabled || (o.disabled && !on);
        return (
          <label key={o.value} className={cx('un-choice', on && 'is-on', off && 'is-off')}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              disabled={off}
              onChange={() => onChange(o.value)}
            />
            <span className="un-choice-text">
              <span className="un-choice-title">
                <b>{o.title}</b>
                {o.tag && <small className="un-choice-tag">{o.tag}</small>}
              </span>
              <small>{o.body}</small>
              {o.reason && o.disabled && <small className="un-choice-reason">{o.reason}</small>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** 1–8 new voices per job: a small range reads better as a stepper than a list. */
export function DesignBudget({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange(next: number): void;
}) {
  const valid = validBudget(value);
  const n = valid ? value : 0;
  return (
    <div className="un-cast-field">
      <span aria-hidden="true">
        새로 만들 인물<small>한 번에 최대 {MAX_BUDGET}명</small>
      </span>
      <div className="un-stepper" role="group" aria-label="새로 만들 인물 수">
        <button
          type="button"
          aria-label="줄이기"
          disabled={disabled || !valid || n <= MIN_BUDGET}
          onClick={() => onChange(n - 1)}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <output aria-live="polite">
          {valid ? (
            <>
              최대 <b>{n}</b>명
            </>
          ) : (
            '인원을 정해 주세요'
          )}
        </output>
        <button
          type="button"
          aria-label="늘리기"
          disabled={disabled || n >= MAX_BUDGET}
          onClick={() => onChange(n + 1)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The selection model reads the text; it is a separate connection from the TTS voices. */
export function SelectionModelField({
  value,
  engines,
  disabled,
  onChange,
}: {
  value?: string;
  engines: readonly SpeakerEngine[];
  disabled?: boolean;
  onChange(id: string | undefined): void;
}) {
  const listed = engines.some((e) => e.id === value);
  return (
    <label className="un-cast-field">
      <span>
        배정 AI 모델<small>본문을 읽고 목소리를 정해요</small>
      </span>
      <select
        aria-label="배정 AI 모델"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        {!listed && (
          <option value={value ?? ''}>{value ? '목록에 없는 모델 · 다시 골라 주세요' : '모델 고르기'}</option>
        )}
        {engines.map((e) => (
          <option key={e.id} value={e.id} disabled={!e.enabled && e.id !== value}>
            {e.name}
            {e.name !== e.modelId ? ` · ${e.modelId}` : ''}
            {e.paid ? ' · 유료' : ''}
            {!e.enabled ? ' · 꺼짐' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function UiNextCastingOptions({
  value,
  engines,
  designer,
  disabled,
  pool,
  poolDescribed,
  onChange,
  onManage,
  onLibrary,
}: {
  value?: SpeakerCastingOptions;
  /** Selection models only. */
  engines: readonly SpeakerEngine[];
  /** The narrator's own Gemini 3.8 Flash TTS connection; undefined means voice creation is not offered. */
  designer?: VoiceDesignProvider;
  disabled: boolean;
  /** The list picker; it means 'voices to rotate', 'candidates' or 'the rest' depending on the mode. */
  pool?: ReactNode;
  /** How many listed candidates carry a description the selection model can read. */
  poolDescribed?: { described: number; total: number };
  onChange(v: SpeakerCastingOptions): void;
  onManage?(): void;
  onLibrary?(): void;
}) {
  const v = value ?? { autoDesign: false, maxDesignedVoices: 4 };
  const patch = (next: Partial<SpeakerCastingOptions>) => onChange({ ...v, ...next });
  const mode = castingMode(v);
  // Going back to order drops the model from the saved choice; this page keeps it to restore on return.
  const [lastEngine, setLastEngine] = useState(v.engineId);
  const engineFor = () => v.engineId ?? lastEngine ?? engines.find((e) => e.enabled)?.id;
  const canSelect = !!v.engineId || !!lastEngine || engines.some((e) => e.enabled);
  const legacyDesign = mode === 'pick' && v.autoDesign;
  // Creation is part of the Flash context only; a saved choice from elsewhere stays visible to be changed.
  const showCreate = !!designer || mode === 'create';
  const choose = (next: CastingMode) => {
    if (next === 'order') {
      setLastEngine(v.engineId ?? lastEngine);
      return patch({ engineId: undefined, autoDesign: false, designMode: undefined });
    }
    if (next === 'pick') return patch({ engineId: engineFor(), autoDesign: false, designMode: undefined });
    patch({
      engineId: engineFor(),
      autoDesign: true,
      designMode: 'characters',
      designProviderId: designer?.id ?? v.designProviderId,
      designModelId: designer?.modelId ?? v.designModelId,
      // Only this explicit switch replaces an unusable saved limit; restoring never rewrites it.
      maxDesignedVoices: validBudget(v.maxDesignedVoices) ? v.maxDesignedVoices : 4,
    });
  };
  const link = (text: string, onClick?: () => void) =>
    onClick ? (
      <button type="button" className="un-listen-link" onClick={onClick}>
        {text}
      </button>
    ) : (
      text
    );
  const needModel = <>목소리를 정할 AI 모델을 {link('연결', onManage)}하면 쓸 수 있어요.</>;
  const options: ChoiceOption<CastingMode>[] = [
    {
      value: 'order',
      title: '순서대로 배정',
      body: '고른 목소리를 인물마다 돌아가며 써요.',
    },
    {
      value: 'pick',
      title: 'AI가 골라 배정',
      body: '인물에 어울리는 목소리를 목록에서 골라요.',
      disabled: !canSelect,
      reason: needModel,
    },
    ...(showCreate
      ? [
          {
            value: 'create' as const,
            title: '인물마다 새 목소리',
            tag: 'Gemini 3.8 Flash',
            body: '본문 속 성별·나이·말투에 맞춰 새로 만들어요.',
            disabled: !designer || !canSelect,
            reason: !designer ? '내레이터가 Gemini 3.8 Flash TTS 목소리일 때만 쓸 수 있어요.' : needModel,
          },
        ]
      : []),
  ];
  const selectionField = (
    <SelectionModelField
      value={v.engineId}
      engines={engines}
      disabled={disabled}
      onChange={(engineId) => engineId && patch({ engineId })}
    />
  );
  const undescribed = poolDescribed ? poolDescribed.total - poolDescribed.described : 0;
  return (
    <section className="un-book-group" aria-label="인물 목소리">
      <div className="un-book-group-head">
        <h3>인물 목소리</h3>
        <div className="un-cast-head-links">
          {onLibrary && link('목소리 보관함', onLibrary)}
          {onManage && link('모델 연결', onManage)}
        </div>
      </div>
      <ChoiceCards label="배정 방식" value={mode} options={options} disabled={disabled} onChange={choose} />
      <div className="un-cast-mode" aria-label="배정 설정">
        {mode === 'order' ? (
          pool
        ) : mode === 'pick' ? (
          <>
            {selectionField}
            {pool}
            {poolDescribed && poolDescribed.total > 0 && (
              <p className="un-book-note">
                {undescribed === 0 ? (
                  '후보 목소리마다 설명이 있어요. 설명을 보고 골라요.'
                ) : (
                  <>
                    설명이 있어야 잘 골라요. 설명 없는 목소리 <b>{undescribed}개</b> · {link('설명 달기', onLibrary)}
                  </>
                )}
              </p>
            )}
            {legacyDesign && (
              <div className="un-cast-legacy">
                <label className="un-book-ack un-cast-toggle">
                  <input
                    type="checkbox"
                    checked
                    disabled={disabled}
                    onChange={(e) => patch({ autoDesign: e.target.checked })}
                  />
                  <span>
                    주요 인물은 새 목소리로 만들기
                    <small className="un-book-note">이전에 저장한 설정이에요. 끄면 목록에서만 골라요.</small>
                  </span>
                </label>
                <DesignBudget
                  value={v.maxDesignedVoices}
                  disabled={disabled}
                  onChange={(maxDesignedVoices) => patch({ maxDesignedVoices })}
                />
              </div>
            )}
          </>
        ) : (
          <>
            {selectionField}
            <DesignBudget
              value={v.maxDesignedVoices}
              disabled={disabled}
              onChange={(maxDesignedVoices) => patch({ maxDesignedVoices })}
            />
            <dl className="un-cast-roles" aria-label="누가 어떤 목소리를 쓰나요">
              <div className="is-new">
                <dt>주요·조연</dt>
                <dd>새 목소리{validBudget(v.maxDesignedVoices) ? ` · 최대 ${v.maxDesignedVoices}명` : ''}</dd>
              </div>
              <div>
                <dt>직접 지정한 인물</dt>
                <dd>지금 목소리 유지</dd>
              </div>
              <div>
                <dt>그 밖의 인물</dt>
                <dd>아래 목록에서 배정</dd>
              </div>
            </dl>
            {pool}
            {designer && (
              <p className="un-book-note">
                <b>{designer.name}</b>에서 만들고 {link('목소리 보관함', onLibrary)}에 저장해요.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
