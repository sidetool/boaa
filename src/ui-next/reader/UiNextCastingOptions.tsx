import { useId, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  isGeminiVoiceDesignModel,
  type SpeakerCastingOptions,
  type VoiceDesignProvider,
} from '../../providers/voice-library';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import { cx } from '../components/primitives';
import './voice-library.css';

export type CastingMode = 'order' | 'pick' | 'create';
export const DESIGN_BUDGETS = [1, 2, 3, 4, 5, 6, 7, 8];
const MIN_BUDGET = DESIGN_BUDGETS[0]!;
const MAX_BUDGET = DESIGN_BUDGETS[DESIGN_BUDGETS.length - 1]!;
/** No model: order. A model alone picks from the list; with natural design it creates a voice per character. */
/** Saved choices without design may hold 0; creating needs 1–8, so 0 is never shown or sent as a working limit. */
export const validBudget = (n?: number) => DESIGN_BUDGETS.includes(n ?? 0);
export const castingMode = (v?: SpeakerCastingOptions): CastingMode =>
  !v?.engineId ? 'order' : v.autoDesign && v.designMode === 'characters' ? 'create' : 'pick';
/** Product scope: only exact Gemini 3.8 Flash TTS connections may create voices, whatever else the server lists. */
export const voiceDesigners = (designers: readonly VoiceDesignProvider[] = []) =>
  designers.filter((d) => isGeminiVoiceDesignModel(d.modelId));
/** The saved connection is usable only while it is listed with the same model; anything else is re-picked, never swapped. */
export const designerFor = (value: SpeakerCastingOptions | undefined, designers: readonly VoiceDesignProvider[]) =>
  voiceDesigners(designers).find((d) => d.id === value?.designProviderId && d.modelId === value?.designModelId);

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  body: ReactNode;
  tag?: string;
  /** Why the option cannot be picked; shown only while it is disabled. */
  reason?: ReactNode;
  disabled?: boolean;
}

/** Radio cards: every choice and what it costs stay visible together, unlike a native select on a phone. */
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
              {o.reason && o.disabled && !on && <small className="un-choice-reason">{o.reason}</small>}
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
        새로 만들 목소리<small>이번 작업 한도</small>
      </span>
      <div className="un-stepper" role="group" aria-label="새로 만들 목소리">
        <button
          type="button"
          aria-label="새로 만들 목소리 줄이기"
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
            '개수를 정해 주세요'
          )}
        </output>
        <button
          type="button"
          aria-label="새로 만들 목소리 늘리기"
          disabled={disabled || n >= MAX_BUDGET}
          onClick={() => onChange(n + 1)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Natural voice creation: the Gemini 3.8 Flash TTS connection and how many voices this job may create. */
export function VoiceDesignFields({
  value,
  designers,
  disabled,
  onChange,
}: {
  value: SpeakerCastingOptions;
  designers: readonly VoiceDesignProvider[];
  disabled: boolean;
  onChange(next: Partial<SpeakerCastingOptions>): void;
}) {
  const usable = voiceDesigners(designers);
  const current = designerFor(value, designers);
  return (
    <>
      <label className="un-cast-field">
        <span>
          목소리 제작 연결<small>Gemini 3.8 Flash TTS</small>
        </span>
        <select
          aria-label="목소리 제작 연결"
          value={current?.id ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const next = usable.find((d) => d.id === e.target.value);
            if (next) onChange({ designProviderId: next.id, designModelId: next.modelId });
          }}
        >
          {!current && <option value="">{value.designProviderId ? '다시 골라 주세요' : '제작 연결 고르기'}</option>}
          {usable.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.paid ? ' · 유료 API' : ''}
            </option>
          ))}
        </select>
      </label>
      <DesignBudget
        value={value.maxDesignedVoices}
        disabled={disabled}
        onChange={(maxDesignedVoices) => onChange({ maxDesignedVoices })}
      />
    </>
  );
}

/** Who ends up with which voice, so nobody has to read a paragraph to find out. */
export function CastingRoles({ budget, revoice }: { budget: number; revoice?: boolean }) {
  const rows: [string, string][] = revoice
    ? [
        ['주요·조연', validBudget(budget) ? `새 목소리 · 최대 ${budget}명` : '새 목소리'],
        ['내레이터', '지금 목소리 그대로'],
        ['아래에서 바꾼 인물', '고른 목소리 그대로'],
        ['작품에서 직접 지정한 인물', '지금 목소리 그대로'],
        ['엑스트라·불확실·초과 인물', '지금 목소리 그대로'],
      ]
    : [
        ['주요·조연', validBudget(budget) ? `새 목소리 · 최대 ${budget}명` : '새 목소리'],
        ['내레이터', '위에서 고른 내레이터 목소리'],
        ['직접 지정·이미 만든 인물', '그 목소리 그대로'],
        ['엑스트라·불확실·초과 인물', '대체용 목소리에서 배정'],
      ];
  return (
    <dl className="un-cast-roles" aria-label="인물별 목소리">
      {rows.map(([who, what], i) => (
        <div key={who} className={cx(i === 0 && 'is-new')}>
          <dt>{who}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function UiNextCastingOptions({
  value,
  engines,
  designers,
  disabled,
  pool,
  poolDescribed,
  onChange,
  onManage,
  onLibrary,
}: {
  value?: SpeakerCastingOptions;
  engines: readonly SpeakerEngine[];
  designers: readonly VoiceDesignProvider[];
  disabled: boolean;
  /** The list picker; it means 'voices to rotate', 'candidates' or 'fallbacks' depending on the mode. */
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
  const usable = voiceDesigners(designers);
  // Going back to order drops the model from the saved choice; this page keeps it to restore on return.
  const [lastEngine, setLastEngine] = useState(v.engineId);
  const missing = v.engineId && !engines.some((e) => e.id === v.engineId);
  const engineFor = () => v.engineId ?? lastEngine ?? engines.find((e) => e.enabled)?.id;
  const canSelect = !!v.engineId || !!lastEngine || engines.some((e) => e.enabled);
  const canCreate = canSelect && usable.length > 0;
  const legacyDesign = mode === 'pick' && v.autoDesign;
  const choose = (next: CastingMode) => {
    if (next === 'order') {
      setLastEngine(v.engineId ?? lastEngine);
      return patch({ engineId: undefined, autoDesign: false, designMode: undefined });
    }
    if (next === 'pick') return patch({ engineId: engineFor(), autoDesign: false, designMode: undefined });
    // A saved connection is kept even if it vanished: it is shown as needing a new pick, never swapped.
    const providerId = v.designProviderId ?? usable[0]?.id;
    patch({
      engineId: engineFor(),
      autoDesign: true,
      designMode: 'characters',
      designProviderId: providerId,
      designModelId: v.designModelId || usable.find((d) => d.id === providerId)?.modelId,
      // Only this explicit switch replaces an unusable saved limit; restoring never rewrites it.
      maxDesignedVoices: validBudget(v.maxDesignedVoices) ? v.maxDesignedVoices : 4,
    });
  };
  const manageLink = (text: string) =>
    onManage ? (
      <button type="button" className="un-listen-link" onClick={onManage}>
        {text}
      </button>
    ) : (
      text
    );
  const options: ChoiceOption<CastingMode>[] = [
    {
      value: 'order',
      title: '순서대로 나누기',
      tag: '모델 요청 없음',
      body: '고른 목소리를 인물에게 차례로 나눠요. 성별·나이·음색은 맞추지 않아요.',
    },
    {
      value: 'pick',
      title: '목록에서 고르기',
      tag: '선정 모델',
      body: '선정 모델이 대사를 읽고 후보 목록에서 어울리는 목소리를 골라요.',
      disabled: !canSelect,
      reason: <>목소리 선정 모델을 {manageLink('연결')}하면 쓸 수 있어요.</>,
    },
    {
      value: 'create',
      title: '인물마다 새로 만들기',
      tag: '선정 모델 + 제작',
      body: '선정 모델이 본문에서 인물의 목소리 특징을 정리하면 Gemini 3.8 Flash TTS가 새 목소리를 만들어 보관해요.',
      disabled: !canCreate,
      reason: !canSelect ? (
        <>목소리 선정 모델을 {manageLink('연결')}하면 쓸 수 있어요.</>
      ) : (
        'BOAA의 이 기능은 Gemini 3.8 Flash TTS(gemini-3.8-flash-tts) 연결에서만 지원해요. Flash-Lite나 다른 TTS 연결은 지원 범위가 아니에요.'
      ),
    },
  ];
  const selectionField = mode !== 'order' && (
    <label className="un-cast-field">
      <span>
        목소리 선정 모델<small>본문을 읽는 언어 모델</small>
      </span>
      <select
        aria-label="목소리 선정 모델"
        value={v.engineId}
        disabled={disabled}
        onChange={(e) => patch({ engineId: e.target.value })}
      >
        {missing && <option value={v.engineId}>목록에 없는 선정 모델</option>}
        {engines.map((e) => (
          <option key={e.id} value={e.id} disabled={!e.enabled}>
            {e.name} · {e.modelId}
          </option>
        ))}
      </select>
    </label>
  );
  const libraryLink = (text: string) =>
    onLibrary ? (
      <button type="button" className="un-listen-link" onClick={onLibrary}>
        {text}
      </button>
    ) : (
      text
    );
  const undescribed = poolDescribed ? poolDescribed.total - poolDescribed.described : 0;
  return (
    <section className="un-book-group" aria-label="인물 목소리">
      <div className="un-book-group-head">
        <h3>인물 목소리</h3>
        <div className="un-cast-head-links">
          {onLibrary && (
            <button type="button" className="un-listen-link" onClick={onLibrary}>
              목소리 보관함
            </button>
          )}
          {onManage && (
            <button type="button" className="un-listen-link" onClick={onManage}>
              모델 연결
            </button>
          )}
        </div>
      </div>
      <ChoiceCards label="인물 목소리 정하기" value={mode} options={options} disabled={disabled} onChange={choose} />
      <div className="un-cast-mode" aria-label="고른 방법의 설정">
        {mode === 'order' ? (
          <>
            {pool}
            <p className="un-book-note">인물에 어울리는 목소리가 필요하면 다른 방법을 골라 주세요.</p>
          </>
        ) : mode === 'pick' ? (
          <>
            {selectionField}
            {pool}
            <p className="un-book-note">
              선정 모델은 목소리를 들을 수 없어서 적힌 정보로만 골라요. 보관함의 별칭·음색·설명을 먼저 보고, 없으면
              제공자 설명을, 그것도 없으면 이름만 참고해요. 그래서 성별·음색이 맞는다고 보장할 수 없어요.
              {poolDescribed && poolDescribed.total > 0 && (
                <>
                  {' '}
                  {undescribed === 0 ? (
                    <b>후보 {poolDescribed.total}개 모두 설명이 있어요.</b>
                  ) : (
                    <>
                      <b>
                        후보 {poolDescribed.total}개 중 {undescribed}개는 설명이 없어요.
                      </b>{' '}
                      {libraryLink('보관함에서 라벨 달기')}
                    </>
                  )}
                </>
              )}
            </p>
          </>
        ) : (
          <>
            {selectionField}
            <VoiceDesignFields value={v} designers={designers} disabled={disabled} onChange={patch} />
            <CastingRoles budget={v.maxDesignedVoices} />
            {pool}
            <p className="un-book-note">
              성별 느낌·연령대·음색·평소 말투는 선정 모델이 본문 근거로 정리해요. 이름이나 라벨을 붙이지 않아도 되고,
              만든 목소리는 {libraryLink('목소리 보관함')}에 저장해 다음 작업에서도 그대로 써요. 선정 모델 요청과 새
              목소리마다 제작 요금이 들어요.
            </p>
          </>
        )}
      </div>
      {legacyDesign && (
        <div className="un-cast-mode">
          <label className="un-book-ack">
            <input
              type="checkbox"
              checked
              disabled={disabled}
              onChange={(e) => patch({ autoDesign: e.target.checked })}
            />
            <span>
              주요 인물만 새 목소리 (이전 방식)
              <small className="un-book-note">
                이전 설정이에요. 주요·조연 모두 새로 만들려면 위에서 ‘인물마다 새로 만들기’를 골라 주세요.
              </small>
            </span>
          </label>
          <VoiceDesignFields value={v} designers={designers} disabled={disabled} onChange={patch} />
        </div>
      )}
    </section>
  );
}
