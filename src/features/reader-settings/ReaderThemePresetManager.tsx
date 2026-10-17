import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import { useReaderThemePresets } from './use-reader-theme-presets';

export function ReaderThemePresetManager({
  profile,
  foreground,
  background,
  updateProfile,
}: {
  readonly profile: ReadingProfile;
  readonly foreground: string;
  readonly background: string;
  readonly updateProfile: (patch: ReadingProfileOverride) => void;
}) {
  const {
    presets,
    name,
    setName,
    error,
    editing,
    renameDraft,
    setRenameDraft,
    duplicate,
    renameDuplicate,
    canRename,
    save: savePreset,
    remove,
    beginRename,
    cancelRename,
    rename,
    apply,
  } = useReaderThemePresets({ profile, foreground, background, updateProfile });
  const save = () => savePreset((name) => window.confirm(`“${name}” 테마의 색상과 밝기를 덮어쓸까요?`));

  return (
    <section className="reader-settings-group">
      <h3>내 리더 테마</h3>
      <p className="field-help">현재 색상과 밝기를 저장합니다.</p>
      <div className="reader-theme-preset-save">
        <label>
          <span className="sr-only">새 리더 테마 이름</span>
          <input
            value={name}
            maxLength={40}
            placeholder="테마 이름"
            aria-label="새 리더 테마 이름"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
        </label>
        <button type="button" className="ghost-btn" disabled={!name.trim()} onClick={save}>
          {duplicate ? '같은 이름의 테마 덮어쓰기' : '현재 색상 저장'}
        </button>
      </div>
      {error && (
        <p className="reader-settings-inline-error" role="alert">
          이 기기에 테마를 저장하지 못했습니다.
        </p>
      )}
      {presets.length > 0 && (
        <div className="reader-theme-preset-list">
          {presets.map((preset) => (
            <article key={preset.id}>
              {editing === preset.id ? (
                <div className="reader-theme-preset-save">
                  <input
                    aria-label="변경할 테마 이름"
                    value={renameDraft}
                    maxLength={40}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                  <button type="button" disabled={!canRename} onClick={() => rename()}>
                    이름 저장
                  </button>
                  <button type="button" onClick={cancelRename}>
                    취소
                  </button>
                  {renameDuplicate && <small role="status">이미 사용 중인 이름입니다.</small>}
                </div>
              ) : (
                <>
                  <button type="button" className="reader-theme-preset-apply" onClick={() => apply(preset.id)}>
                    <span style={{ color: preset.foreground, background: preset.background }}>가</span>
                    <strong>{preset.name}</strong>
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => beginRename(preset.id)}>
                    이름 변경
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => remove(preset.id)}>
                    삭제
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
