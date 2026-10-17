import { Check, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import type { ReadingProfile, ReadingProfileOverride } from '../../../domain/types';
import { useReaderThemePresets } from '../../../features/reader-settings/use-reader-theme-presets';
import { useUserFonts, type UserFontError } from '../../../features/reader-settings/use-user-fonts';
import type { ReaderPersonalizationRepository } from '../../../repositories/reader-personalization-repository';
import { formatBytes } from '../../../utils/format';
import { ConfirmSheet, PromptSheet } from '../../components/dialogs';
import { cx, Sheet } from '../../components/primitives';
import { Notice } from '../../components/prefs';

/** Saved color themes as swatches: tap to wear one, 관리 to rename or delete. */
export function SavedThemes({
  profile,
  foreground,
  background,
  updateProfile,
}: {
  profile: ReadingProfile;
  foreground: string;
  background: string;
  updateProfile(patch: ReadingProfileOverride): void;
}) {
  const model = useReaderThemePresets({ profile, foreground, background, updateProfile });
  const [naming, setNaming] = useState(false);
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [removing, setRemoving] = useState<{ id: string; name: string }>();
  const wearing = (preset: (typeof model.presets)[number]) =>
    profile.theme === 'custom' &&
    preset.foreground.toLowerCase() === foreground.toLowerCase() &&
    preset.background.toLowerCase() === background.toLowerCase() &&
    preset.brightness === profile.brightness;

  return (
    <div className="un-saved-themes">
      <div className="un-saved-themes-head">
        <span>내 테마</span>
        {model.presets.length > 0 && (
          <button type="button" className="un-btn is-text is-sm" onClick={() => setManaging(true)}>
            관리
          </button>
        )}
      </div>
      <div className="un-saved-themes-row">
        {model.presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={cx('un-saved-theme', wearing(preset) && 'is-active')}
            onClick={() => model.apply(preset.id)}
          >
            <span
              style={{
                background: preset.background,
                color: preset.foreground,
                filter: `brightness(${preset.brightness})`,
              }}
              aria-hidden="true"
            >
              가{wearing(preset) && <Check size={13} />}
            </span>
            {preset.name}
          </button>
        ))}
        <button type="button" className="un-saved-theme is-add" onClick={() => setNaming(true)}>
          <span aria-hidden="true">
            <Plus size={18} />
          </span>
          지금 색 저장
        </button>
      </div>
      {model.error && <Notice tone="danger">테마를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.</Notice>}

      <PromptSheet
        open={naming}
        title="지금 색을 테마로 저장"
        label="테마 이름"
        placeholder="예: 밤에 읽기"
        confirmLabel="저장"
        check={(name) =>
          model.presets.some((preset) => preset.name === name)
            ? { warning: '같은 이름의 테마가 있어요. 저장하면 지금 색으로 바뀌어요.' }
            : undefined
        }
        onSubmit={(name) => model.save(() => true, name)}
        onClose={() => setNaming(false)}
      />

      <Sheet open={managing} onClose={() => setManaging(false)} title="내 테마">
        <ul className="un-manage-list">
          {model.presets.map((preset) => (
            <li key={preset.id}>
              <span className="un-manage-swatch" style={{ background: preset.background, color: preset.foreground }}>
                가
              </span>
              <span className="un-manage-name">{preset.name}</span>
              <button
                type="button"
                className="un-icon-btn is-sm"
                aria-label={`${preset.name} 이름 바꾸기`}
                onClick={() => setRenaming({ id: preset.id, name: preset.name })}
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className="un-icon-btn is-sm"
                aria-label={`${preset.name} 지우기`}
                onClick={() => setRemoving({ id: preset.id, name: preset.name })}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
      <PromptSheet
        open={Boolean(renaming)}
        title="테마 이름 바꾸기"
        label="테마 이름"
        initial={renaming?.name}
        confirmLabel="바꾸기"
        check={(name) =>
          model.presets.some((preset) => preset.id !== renaming?.id && preset.name === name)
            ? { error: '같은 이름의 테마가 이미 있어요.' }
            : undefined
        }
        onSubmit={(name) => renaming && model.rename({ id: renaming.id, name })}
        onClose={() => setRenaming(undefined)}
      />
      <ConfirmSheet
        open={Boolean(removing)}
        title="테마를 지울까요?"
        confirmLabel="지우기"
        danger
        onConfirm={() => removing && model.remove(removing.id)}
        onClose={() => setRemoving(undefined)}
      >
        <p>‘{removing?.name}’ 테마를 지워요. 지금 화면 색은 그대로예요.</p>
      </ConfirmSheet>
    </div>
  );
}

const FONT_ERROR: Record<UserFontError, string> = {
  duplicate: '이미 추가한 글꼴이에요.',
  size_invalid: '글꼴 파일이 너무 크거나 비어 있어요.',
  save_failed: '글꼴을 저장하지 못했어요.',
  load_failed: '이 글꼴은 열 수 없어요.',
  format_invalid: 'WOFF2, WOFF, TTF, OTF 글꼴만 추가할 수 있어요.',
};

/** Fonts the reader added: pick one, rename it, delete it, or add another file. */
export function UserFonts({
  repository,
  activeFontId,
  selectFont,
}: {
  repository?: ReaderPersonalizationRepository;
  activeFontId: string;
  selectFont(id: string): void;
}) {
  const model = useUserFonts({ repository, activeFontId, selectFont });
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [removing, setRemoving] = useState<{ id: string; name: string }>();
  if (!repository) return null;
  return (
    <div className="un-user-fonts">
      {model.fonts.length > 0 && (
        <ul className="un-pref-group un-user-font-list">
          {model.fonts.map((font) => {
            const active = activeFontId === font.id;
            return (
              <li key={font.id} className={cx('un-pref', active && 'is-active')}>
                <button type="button" className="un-user-font-pick" onClick={() => selectFont(font.id)}>
                  <span className="un-pref-option-mark" aria-hidden="true" />
                  <span className="un-pref-text">
                    <strong>{font.familyLabel}</strong>
                    <small>
                      {font.style === 'italic' ? '기울임' : '보통'} · {font.weight} · {formatBytes(font.byteLength)}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${font.familyLabel} 이름 바꾸기`}
                  onClick={() => setRenaming({ id: font.id, name: font.familyLabel })}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${font.familyLabel} 지우기`}
                  onClick={() => setRemoving({ id: font.id, name: font.familyLabel })}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={model.inputRef}
        type="file"
        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void model.install(file);
        }}
      />
      <button
        type="button"
        className="un-btn is-ghost un-user-font-add"
        disabled={model.busy}
        onClick={() => model.inputRef.current?.click()}
      >
        <Upload size={16} />
        {model.busy ? '글꼴 확인 중…' : '내 글꼴 추가'}
      </button>
      {model.error && <Notice tone="danger">{FONT_ERROR[model.error]}</Notice>}
      {model.operationError && (
        <Notice tone="danger">
          {model.operationError === 'list_failed'
            ? '글꼴 목록을 불러오지 못했어요.'
            : model.operationError === 'rename_failed'
              ? '이름을 바꾸지 못했어요.'
              : '글꼴을 지우지 못했어요.'}
        </Notice>
      )}

      <PromptSheet
        open={Boolean(renaming)}
        title="글꼴 이름 바꾸기"
        label="글꼴 이름"
        initial={renaming?.name}
        confirmLabel="바꾸기"
        onSubmit={(name) => renaming && void model.rename(renaming.id, name)}
        onClose={() => setRenaming(undefined)}
      />
      <ConfirmSheet
        open={Boolean(removing)}
        title="글꼴을 지울까요?"
        confirmLabel="지우기"
        danger
        onConfirm={() => removing && void model.remove(removing.id)}
        onClose={() => setRemoving(undefined)}
      >
        <p>‘{removing?.name}’ 글꼴을 이 기기에서 지워요. 쓰고 있었다면 명조로 바뀌어요.</p>
      </ConfirmSheet>
    </div>
  );
}
