import { useState } from 'react';
import type { SpeakerCastingOptions, VoiceDesignProvider } from '../../providers/voice-library';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import './voice-library.css';

export type CastingMode = 'order' | 'pick' | 'create';
export const DESIGN_BUDGETS = [1, 2, 3, 4, 5, 6, 7, 8];
/** No model: order. A model alone picks from the list; with natural design it creates a voice per character. */
export const castingMode = (v?: SpeakerCastingOptions): CastingMode =>
  !v?.engineId ? 'order' : v.autoDesign && v.designMode === 'characters' ? 'create' : 'pick';

/** Natural voice creation: one budgeted voice per major or supporting character, from the original text. */
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
  return (
    <>
      <label className="un-cast-field">
        <span>목소리 제작 연결</span>
        <select
          aria-label="목소리 제작 연결"
          value={value.designProviderId ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              designProviderId: e.target.value,
              designModelId: designers.find((d) => d.id === e.target.value)?.modelId ?? '',
            })
          }
        >
          {!designers.some((d) => d.id === value.designProviderId) && (
            <option value={value.designProviderId ?? ''}>
              {value.designProviderId ? '목록에 없는 연결' : '제작 연결 고르기'}
            </option>
          )}
          {designers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.paid ? ' · 유료 API' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="un-cast-field">
        <span>새로 만들 목소리</span>
        <select
          aria-label="새로 만들 목소리"
          value={value.maxDesignedVoices}
          disabled={disabled}
          onChange={(e) => onChange({ maxDesignedVoices: Number(e.target.value) })}
        >
          {DESIGN_BUDGETS.map((n) => (
            <option key={n} value={n}>
              최대 {n}개
            </option>
          ))}
        </select>
      </label>
      <details className="un-cast-options">
        <summary>고급 · 제작 모델 {value.designModelId || '미지정'}</summary>
        <label className="un-cast-field">
          <span>목소리 제작 모델 ID</span>
          <input
            value={value.designModelId ?? ''}
            disabled={disabled}
            maxLength={200}
            onChange={(e) => onChange({ designModelId: e.target.value })}
          />
        </label>
      </details>
    </>
  );
}

export default function UiNextCastingOptions({
  value,
  engines,
  designers,
  disabled,
  onChange,
  onManage,
}: {
  value?: SpeakerCastingOptions;
  engines: readonly SpeakerEngine[];
  designers: readonly VoiceDesignProvider[];
  disabled: boolean;
  onChange(v: SpeakerCastingOptions): void;
  onManage?(): void;
}) {
  const v = value ?? { autoDesign: false, maxDesignedVoices: 4 };
  const patch = (next: Partial<SpeakerCastingOptions>) => onChange({ ...v, ...next });
  const mode = castingMode(v);
  // Going back to order drops the model from the saved choice; this page keeps it to restore on return.
  const [lastEngine, setLastEngine] = useState(v.engineId);
  const missing = v.engineId && !engines.some((e) => e.id === v.engineId);
  const engineFor = () => v.engineId ?? lastEngine ?? engines.find((e) => e.enabled)?.id;
  const canSelect = !!v.engineId || !!lastEngine || engines.some((e) => e.enabled);
  const legacyDesign = mode === 'pick' && v.autoDesign;
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
      designProviderId: v.designProviderId ?? designers[0]?.id,
      designModelId:
        v.designModelId || designers.find((d) => d.id === (v.designProviderId ?? designers[0]?.id))?.modelId,
    });
  };
  return (
    <section className="un-book-group" aria-label="인물 목소리">
      <div className="un-book-group-head">
        <h3>인물 목소리</h3>
        {onManage && (
          <button type="button" className="un-listen-link" onClick={onManage}>
            모델 연결
          </button>
        )}
      </div>
      <label className="un-cast-field">
        <span>인물 목소리 정하기</span>
        <select
          aria-label="인물 목소리 정하기"
          value={mode}
          disabled={disabled}
          onChange={(e) => choose(e.target.value as CastingMode)}
        >
          <option value="order">순서대로 나누기 · 모델 요청 없음</option>
          <option value="pick" disabled={!canSelect}>
            목록에서 어울리는 목소리 고르기 · 선정 모델{canSelect ? '' : ' 연결 필요'}
          </option>
          <option value="create" disabled={mode !== 'create' && (!canSelect || designers.length === 0)}>
            인물마다 새 목소리 만들기 · 선정 모델 + 목소리 제작
            {mode !== 'create' && designers.length === 0 ? ' · 제작 지원 연결 없음' : ''}
          </option>
        </select>
      </label>
      {mode !== 'order' && (
        <label className="un-cast-field">
          <span>목소리 선정 모델</span>
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
      )}
      {mode === 'order' ? (
        <p className="un-book-note">
          고른 목소리를 차례로 나눌 뿐, 인물의 성별·나이·음색과 맞추지 않아요. 인물에 어울리는 목소리가 필요하면 다른
          방법을 골라 주세요.
          {designers.length === 0 &&
            ' 인물마다 새 목소리 만들기는 목소리 제작을 지원하는 Gemini 3.8 Flash TTS 연결이 있어야 해요.'}
        </p>
      ) : mode === 'pick' ? (
        <p className="un-book-note">
          선정 모델이 인물의 대사와 보관함의 별칭·음색·설명을 보고 아래 목록에서 골라요. 보관함 라벨이 없는 목소리는
          제공자의 기본 설명이 있으면 그것을, 없으면 이름만 참고하므로 성별·음색이 맞는다고 보장할 수 없어요. 이미 정한
          배정은 계속 사용해요.
        </p>
      ) : (
        <>
          <p className="un-book-note">
            선정 모델이 원문에서 주요·조연 인물의 성별·나이대·음색·말투 같은 고정 특징을 정리하고, 그 설명으로 인물마다
            새 목소리를 만들어 보관함에 저장해요. 이름이나 라벨을 정할 필요는 없어요.
          </p>
          <VoiceDesignFields value={v} designers={designers} disabled={disabled} onChange={patch} />
          <p className="un-book-note">
            내레이터는 고른 내레이터 목소리를, 엑스트라·정체가 불확실한 인물과 최대 개수를 넘는 인물은 대체용 목소리를
            써요. 이미 새로 만든 목소리와 직접 지정한 목소리는 다음 생성에서도 그대로 쓰고, 그 밖의 자동 배정은 새로
            만든 목소리로 바꿔요. 선정 모델 요청과 새 목소리마다 제작 요금이 들어요. 장면별 감정은 ‘자동 연기’가 따로
            맡아요.
          </p>
        </>
      )}
      {legacyDesign && (
        <>
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
                이전 설정이에요. 인물마다 새로 만들려면 위에서 ‘인물마다 새 목소리 만들기’를 골라 주세요.
              </small>
            </span>
          </label>
          <VoiceDesignFields value={v} designers={designers} disabled={disabled} onChange={patch} />
        </>
      )}
    </section>
  );
}
