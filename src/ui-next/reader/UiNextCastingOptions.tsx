import type { SpeakerCastingOptions, VoiceDesignProvider } from '../../providers/voice-library';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import './voice-library.css';

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
  const missing = v.engineId && !engines.some((e) => e.id === v.engineId);
  return (
    <section className="un-book-group" aria-label="인물 목소리 자동 배정">
      <div className="un-book-group-head">
        <h3>인물 목소리 자동 배정</h3>
        {onManage && (
          <button type="button" className="un-listen-link" onClick={onManage}>
            모델 연결
          </button>
        )}
      </div>
      <label className="un-cast-field">
        <span>목소리 선정 모델</span>
        <select
          value={v.engineId ?? ''}
          disabled={disabled}
          onChange={(e) =>
            patch({ engineId: e.target.value || undefined, ...(!e.target.value ? { autoDesign: false } : {}) })
          }
        >
          <option value="">기본 자동 배정 · 추가 모델 요청 없음</option>
          {missing && <option value={v.engineId}>목록에 없는 선정 모델</option>}
          {engines.map((e) => (
            <option key={e.id} value={e.id} disabled={!e.enabled}>
              {e.name} · {e.modelId}
            </option>
          ))}
        </select>
      </label>
      <p className="un-book-note">
        화자 분석과 따로 고를 수 있어요. 선정 모델은 인물의 대사와 보관함의 음색·설명을 참고하고, 이미 정한 배정은 계속
        사용해요.
      </p>
      {(designers.length > 0 || v.autoDesign) && (
        <>
          <label className="un-book-ack">
            <input
              type="checkbox"
              checked={v.autoDesign}
              disabled={disabled || !v.engineId}
              onChange={(e) =>
                patch({
                  autoDesign: e.target.checked,
                  designProviderId: v.designProviderId ?? designers[0]?.id,
                  designModelId: v.designModelId ?? designers[0]?.modelId,
                })
              }
            />
            <span>
              주요 인물에게 어울리는 목소리 만들기
              <small className="un-book-note">
                필요한 경우 설명으로 새 목소리를 만들어요. 엑스트라는 기존 목소리를 함께 써요.
              </small>
            </span>
          </label>
          {v.autoDesign && (
            <details className="un-cast-options">
              <summary>목소리 제작 설정 · 최대 {v.maxDesignedVoices}개</summary>
              <label className="un-cast-field">
                <span>목소리 제작 TTS</span>
                <select
                  value={v.designProviderId ?? ''}
                  disabled={disabled}
                  onChange={(e) =>
                    patch({
                      designProviderId: e.target.value,
                      designModelId: designers.find((d) => d.id === e.target.value)?.modelId ?? '',
                    })
                  }
                >
                  {!designers.some((d) => d.id === v.designProviderId) && (
                    <option value={v.designProviderId ?? ''}>목록에 없는 연결</option>
                  )}
                  {designers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="un-cast-field">
                <span>목소리 제작 모델 ID</span>
                <input
                  value={v.designModelId ?? ''}
                  disabled={disabled}
                  maxLength={200}
                  onChange={(e) => patch({ designModelId: e.target.value })}
                />
              </label>
              <label className="un-cast-field">
                <span>이번 작업에서 새로 만들 목소리</span>
                <select
                  value={v.maxDesignedVoices}
                  disabled={disabled}
                  onChange={(e) => patch({ maxDesignedVoices: Number(e.target.value) })}
                >
                  {[1, 2, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      최대 {n}개
                    </option>
                  ))}
                </select>
              </label>
              <p className="un-book-note">
                실제 목소리는 음성 제작을 지원하는 TTS 모델로 만들고 보관함에 저장해요. 다음 작업에서는 다시 만들지 않고
                재사용해요.
              </p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
