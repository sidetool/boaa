import { useEffect, useRef, useState } from 'react';
import { inspectVertexJson, VERTEX_JSON_MAX_BYTES } from '../../providers/vertex-connection';
import type { Draft } from './speaker-engine-draft';

export default function SpeakerVertexFields({
  draft,
  stored,
  patch,
  onReading,
}: {
  draft: Draft;
  stored: boolean;
  patch(value: Partial<Draft>): void;
  onReading(value: boolean): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const project = useRef(draft.projectId);
  project.current = draft.projectId;
  const [error, setError] = useState<string>();
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const read = async (file?: File) => {
    const own = ++epoch.current;
    setError(undefined);
    onReading(false);
    if (!file) return;
    if (file.size > VERTEX_JSON_MAX_BYTES) return setError('JSON 파일은 64 KiB 이하여야 해요.');
    onReading(true);
    try {
      const text = await file.text();
      if (own !== epoch.current) return;
      const result = inspectVertexJson(text);
      if ('error' in result) return setError(result.error);
      patch({ serviceAccountJson: text, ...(!project.current ? { projectId: result.projectId } : {}) });
    } catch {
      if (own === epoch.current) setError('파일을 읽지 못했어요. JSON 키 파일을 다시 골라 주세요.');
    } finally {
      if (own === epoch.current) onReading(false);
    }
  };
  return (
    <>
      <div className="is-wide un-speaker-json">
        <span>서비스 계정 JSON</span>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="서비스 계정 JSON 파일"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void read(file);
          }}
        />
        <div className="un-tts-conn-probe">
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => input.current?.click()}>
            JSON 파일 선택
          </button>
          {draft.serviceAccountJson && (
            <button
              type="button"
              className="un-listen-link"
              onClick={() => {
                epoch.current++;
                onReading(false);
                setError(undefined);
                patch({ serviceAccountJson: '' });
              }}
            >
              선택 취소
            </button>
          )}
        </div>
        <small className="un-filter-help" role="status">
          {draft.serviceAccountJson
            ? '새 JSON을 선택했어요. 저장하면 적용돼요.'
            : stored
              ? '저장된 JSON을 사용해요. 바꿀 때만 새 파일을 고르세요.'
              : '키는 서버 계정에 암호화해 저장해요.'}
        </small>
        {error && (
          <p className="un-filter-help is-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <label className="is-wide">
        <span>프로젝트 ID</span>
        <input
          value={draft.projectId}
          maxLength={63}
          autoCapitalize="off"
          spellCheck={false}
          placeholder="JSON에서 자동으로 채워요"
          onChange={(e) => patch({ projectId: e.target.value })}
        />
      </label>
      <label className="is-wide">
        <span>리전</span>
        <input
          value={draft.location}
          maxLength={63}
          autoCapitalize="off"
          spellCheck={false}
          placeholder="global"
          onChange={(e) => patch({ location: e.target.value })}
        />
        <small className="un-filter-help">
          기본값은 global이에요. 모델에 따라 us-central1 같은 리전을 지정할 수 있어요.
        </small>
      </label>
    </>
  );
}
