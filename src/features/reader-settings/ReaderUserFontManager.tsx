import { Pencil, Trash2, Upload } from 'lucide-react';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { formatBytes } from '../../utils/format';
import { useUserFonts } from './use-user-fonts';
const fontErrors = {
  duplicate: '이미 등록된 글꼴입니다.',
  size_invalid: '글꼴은 10MB 이하만 등록할 수 있습니다.',
  save_failed: '글꼴을 저장하거나 목록을 새로 고치지 못했습니다. 서버 연결과 저장 공간을 확인해 주세요.',
  load_failed: '글꼴을 읽지 못했습니다. 손상된 파일이거나 앱에서 글꼴 로딩이 차단되었을 수 있습니다.',
  format_invalid: '유효한 WOFF2, WOFF, TTF 또는 OTF 글꼴인지 확인하세요.',
};

export function ReaderUserFontManager({
  repository,
  activeFontId,
  selectFont,
}: {
  readonly repository?: ReaderPersonalizationRepository;
  readonly activeFontId: string;
  selectFont(id: string): void;
}) {
  const {
    inputRef,
    fonts,
    busy,
    error: errorCode,
    install,
    rename,
    remove,
  } = useUserFonts({ repository, activeFontId, selectFont });
  const error = errorCode ? fontErrors[errorCode] : undefined;
  if (!repository) return null;

  return (
    <div className="reader-user-fonts">
      <input
        ref={inputRef}
        type="file"
        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void install(file);
        }}
      />
      <button type="button" className="ghost-btn wide" disabled={busy} onClick={() => inputRef.current?.click()}>
        <Upload size={16} /> {busy ? '글꼴 확인 중' : '내 글꼴 추가'}
      </button>
      {error && <p className="reader-settings-inline-error">{error}</p>}
      {fonts.map((font) => (
        <div key={font.id} className={`reader-user-font-row${activeFontId === font.id ? ' active' : ''}`}>
          <button type="button" className="reader-user-font-select" onClick={() => selectFont(font.id)}>
            <strong>{font.familyLabel}</strong>
            <span>
              {font.style === 'italic' ? '기울임' : '보통'} · {font.weight} · {formatBytes(font.byteLength)}
            </span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`${font.familyLabel} 이름 변경`}
            title="이름 변경"
            onClick={() => {
              const familyLabel = window.prompt('글꼴 이름', font.familyLabel)?.trim();
              if (!familyLabel) return;
              void rename(font.id, familyLabel);
            }}
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            aria-label={`${font.familyLabel} 삭제`}
            title="삭제"
            onClick={() => {
              if (!window.confirm(`'${font.familyLabel}' 글꼴을 삭제할까요?`)) return;
              void remove(font.id);
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
