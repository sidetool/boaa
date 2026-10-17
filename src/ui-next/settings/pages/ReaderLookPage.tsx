import { Check } from 'lucide-react';
import type { ReadingProfile, ReadingProfileOverride } from '../../../domain/types';
import { createReaderAppearanceModel } from '../../../features/reader-settings/reader-appearance-model';
import {
  READER_CONTENT_WIDTH_MAX,
  READER_CONTENT_WIDTH_MIN,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  readingPresets,
} from '../../../features/reader-settings/reader-settings-model';
import { resolveReaderThemeColors } from '../../../features/reader-settings/reader-theme-colors';
import { READING_PROFILE_LIMITS } from '../../../features/reader-settings/reading-profile';
import { builtinFontFamily } from '../../../features/reader-settings/user-font-runtime';
import type { ReaderSettingsController } from '../../../features/reader-settings/useReaderSettingsDraft';
import type { ReaderPersonalizationRepository } from '../../../repositories/reader-personalization-repository';
import { cx, Segmented } from '../../components/primitives';
import { SavedThemes, UserFonts } from './ReaderLookParts';
import { Pref, PrefChips, PrefFold, PrefGroup, PrefSection, PrefSlider, PrefSwitch } from '../../components/prefs';

const THEMES: readonly { id: ReadingProfile['theme']; label: string }[] = [
  { id: 'light', label: '종이' },
  { id: 'sepia', label: '누런 종이' },
  { id: 'dark', label: '어둡게' },
  { id: 'midnight', label: '밤' },
  { id: 'custom', label: '직접 고르기' },
];

const LIMIT = READING_PROFILE_LIMITS;

const fixed = (digits: number) => (value: number) => value.toFixed(digits);
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The paragraph the page is tuned against. Stays in view while sliders move on phones. */
function Preview({ profile }: { profile: ReadingProfile }) {
  const colors = resolveReaderThemeColors(profile);
  return (
    <div
      className="un-look-preview"
      aria-label="본문 미리보기"
      style={{
        color: colors.foreground,
        background: colors.background,
        filter: `brightness(${profile.brightness})`,
        paddingInline: `${Math.min(profile.marginX * 2, 48)}px`,
      }}
    >
      <article
        style={{
          // User fonts load under this family once the reader has used them; until then the serif stands in.
          fontFamily: builtinFontFamily(profile.fontId) ?? `"Boaa User ${profile.fontId}", var(--un-serif)`,
          maxWidth: `${profile.contentWidth}px`,
          fontSize: `${profile.fontSize}px`,
          fontWeight: profile.fontWeight,
          lineHeight: profile.lineHeight,
          letterSpacing: `${profile.letterSpacing}em`,
          wordSpacing: `${profile.wordSpacing}em`,
          fontStyle: profile.fontStyle,
          textDecoration: profile.textDecoration,
          wordBreak: profile.lineBreak === 'anywhere' ? 'break-all' : 'keep-all',
          overflowWrap: profile.lineBreak === 'keep_words' ? 'break-word' : 'anywhere',
          textAlign: profile.textAlign,
          gap: `${profile.paragraphSpacing}em`,
          textIndent: `${profile.firstLineIndent}em`,
        }}
      >
        <p>비가 그친 뒤의 거리는 놀랄 만큼 조용했다. 젖은 가로등 아래로 오래된 약속의 흔적이 번졌다.</p>
        <p>그는 책갈피를 넘기듯 천천히 다음 기억을 떠올렸다.</p>
      </article>
      <span className="un-look-preview-meta" aria-hidden="true">
        {profile.fontSize}px · {percent(profile.lineHeight)}
      </span>
    </div>
  );
}

/** 리더 보기: theme, type and spacing for text books, tuned against a live paragraph. */
export function ReaderLookPage({
  controller,
  profile,
  updateProfile,
  personalizationRepository,
}: {
  controller: ReaderSettingsController;
  profile: ReadingProfile;
  updateProfile(patch: ReadingProfileOverride): void;
  personalizationRepository?: ReaderPersonalizationRepository;
}) {
  const model = createReaderAppearanceModel({ controller, profile, updateProfile, themeTarget: 'reader' });
  const colors = model.readerColors;
  const builtinFont = (['builtin-serif', 'builtin-sans', 'builtin-mono'] as const).find((id) => id === profile.fontId);

  return (
    <>
      <Preview profile={profile} />

      <PrefSection title="빠른 설정" hint="글꼴·크기·간격·여백을 한 번에 바꿔요. 색은 그대로예요.">
        <PrefChips
          label="빠른 설정"
          value=""
          options={readingPresets.map((preset) => ({ value: preset.id, label: preset.label }))}
          onChange={(id) => {
            const preset = readingPresets.find((item) => item.id === id);
            if (preset) model.applyPreset(preset.settings);
          }}
        />
      </PrefSection>

      <PrefSection title="테마">
        <div className="un-look-themes" role="radiogroup" aria-label="리더 테마">
          {THEMES.map((theme) => {
            const swatch = resolveReaderThemeColors({ ...profile, theme: theme.id });
            const active = profile.theme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={cx('un-look-theme', active && 'is-active')}
                onClick={() => model.selectTheme(theme.id)}
              >
                <span style={{ background: swatch.background, color: swatch.foreground }} aria-hidden="true">
                  가{active && <Check size={14} />}
                </span>
                {theme.label}
              </button>
            );
          })}
        </div>
        <PrefGroup>
          {profile.theme === 'custom' && (
            <>
              <Pref
                title="글자 색"
                control={
                  <input
                    type="color"
                    className="un-color"
                    aria-label="글자 색"
                    value={colors.foreground}
                    onChange={(event) => updateProfile({ theme: 'custom', foreground: event.target.value })}
                  />
                }
              />
              <Pref
                title="배경 색"
                control={
                  <input
                    type="color"
                    className="un-color"
                    aria-label="배경 색"
                    value={colors.background}
                    onChange={(event) => updateProfile({ theme: 'custom', background: event.target.value })}
                  />
                }
              />
            </>
          )}
          <PrefSlider
            title="밝기"
            value={Math.round(profile.brightness * 100)}
            min={Math.round(LIMIT.brightness.min * 100)}
            max={Math.round(LIMIT.brightness.max * 100)}
            step={5}
            format={(value) => `${value}%`}
            reset={{ value: 100 }}
            onChange={(value) => updateProfile({ brightness: value / 100 })}
          />
        </PrefGroup>
        <SavedThemes
          profile={profile}
          foreground={colors.foreground}
          background={colors.background}
          updateProfile={updateProfile}
        />
      </PrefSection>

      <PrefSection title="글꼴">
        <Segmented
          label="본문 글꼴"
          value={builtinFont ?? 'custom'}
          options={[
            { value: 'builtin-serif', label: '명조' },
            { value: 'builtin-sans', label: '고딕' },
            { value: 'builtin-mono', label: '고정폭' },
            ...(builtinFont ? [] : [{ value: 'custom' as const, label: '내 글꼴' }]),
          ]}
          onChange={(fontId) => fontId !== 'custom' && updateProfile({ fontId })}
        />
        <UserFonts
          repository={personalizationRepository}
          activeFontId={profile.fontId}
          selectFont={(fontId) => updateProfile({ fontId })}
        />
      </PrefSection>

      <PrefSection title="글자와 간격">
        <PrefGroup>
          <PrefSlider
            title="글자 크기"
            value={profile.fontSize}
            min={READER_FONT_SIZE_MIN}
            max={READER_FONT_SIZE_MAX}
            format={(value) => `${value}px`}
            onChange={(fontSize) => updateProfile({ fontSize })}
          />
          <PrefSlider
            title="줄 간격"
            value={profile.lineHeight}
            min={LIMIT.lineHeight.min}
            max={LIMIT.lineHeight.max}
            step={0.05}
            format={percent}
            onChange={(lineHeight) => updateProfile({ lineHeight })}
          />
          <PrefSlider
            title="문단 간격"
            value={profile.paragraphSpacing}
            min={LIMIT.paragraphSpacing.min}
            max={LIMIT.paragraphSpacing.max}
            step={0.05}
            format={fixed(2)}
            onChange={(paragraphSpacing) => updateProfile({ paragraphSpacing })}
          />
          <PrefSlider
            title="첫 줄 들여쓰기"
            value={profile.firstLineIndent}
            min={LIMIT.firstLineIndent.min}
            max={LIMIT.firstLineIndent.max}
            step={0.25}
            format={(value) => (value ? `${value}칸` : '없음')}
            onChange={(firstLineIndent) => updateProfile({ firstLineIndent })}
          />
          <Pref
            stacked
            title="문단 맞춤"
            control={
              <Segmented
                label="문단 맞춤"
                value={profile.textAlign}
                options={[
                  { value: 'start', label: '왼쪽' },
                  { value: 'justify', label: '양쪽' },
                ]}
                onChange={(textAlign) => updateProfile({ textAlign })}
              />
            }
          />
        </PrefGroup>
        <PrefFold title="세부 조정" summary="굵기, 자간, 단어 간격, 줄바꿈, 기울임">
          <PrefSlider
            title="굵기"
            value={profile.fontWeight}
            min={LIMIT.fontWeight.min}
            max={LIMIT.fontWeight.max}
            step={100}
            onChange={(fontWeight) => updateProfile({ fontWeight })}
          />
          <PrefSlider
            title="자간"
            value={profile.letterSpacing}
            min={LIMIT.letterSpacing.min}
            max={LIMIT.letterSpacing.max}
            step={0.01}
            format={fixed(2)}
            reset={{ value: 0 }}
            onChange={(letterSpacing) => updateProfile({ letterSpacing })}
          />
          <PrefSlider
            title="단어 간격"
            value={profile.wordSpacing}
            min={LIMIT.wordSpacing.min}
            max={LIMIT.wordSpacing.max}
            step={0.02}
            format={fixed(2)}
            reset={{ value: 0 }}
            onChange={(wordSpacing) => updateProfile({ wordSpacing })}
          />
          <Pref
            stacked
            title="줄바꿈"
            help="긴 단어가 줄 끝에 걸릴 때 어떻게 나눌지 정해요."
            control={
              <Segmented
                label="줄바꿈"
                value={profile.lineBreak}
                options={[
                  { value: 'default', label: '기본' },
                  { value: 'keep_words', label: '단어 지키기' },
                  { value: 'anywhere', label: '글자 단위' },
                ]}
                onChange={(lineBreak) => updateProfile({ lineBreak })}
              />
            }
          />
          <PrefSwitch
            title="기울임"
            checked={profile.fontStyle === 'italic'}
            onChange={(on) => updateProfile({ fontStyle: on ? 'italic' : 'normal' })}
          />
          <PrefSwitch
            title="밑줄"
            checked={profile.textDecoration === 'underline'}
            onChange={(on) => updateProfile({ textDecoration: on ? 'underline' : 'none' })}
          />
        </PrefFold>
      </PrefSection>

      <PrefSection title="여백">
        <PrefGroup>
          <PrefSlider
            title="좌우 여백"
            value={profile.marginX}
            min={LIMIT.marginX.min}
            max={LIMIT.marginX.max}
            onChange={(marginX) => updateProfile({ marginX })}
          />
          <PrefSlider
            title="위아래 여백"
            value={profile.marginY}
            min={LIMIT.marginY.min}
            max={LIMIT.marginY.max}
            onChange={(marginY) => updateProfile({ marginY })}
          />
          <PrefSlider
            title="본문 최대 폭"
            help="넓은 화면에서 한 줄이 너무 길어지지 않게 해요."
            value={profile.contentWidth}
            min={READER_CONTENT_WIDTH_MIN}
            max={READER_CONTENT_WIDTH_MAX}
            step={20}
            format={(value) => `${value}px`}
            onChange={(contentWidth) => updateProfile({ contentWidth })}
          />
        </PrefGroup>
      </PrefSection>

      <PrefSection title="넘기는 방식">
        <PrefGroup>
          <Pref
            stacked
            title="읽기 방식"
            help={
              profile.modeLock === 'auto'
                ? '책에 맞춰 스크롤이나 페이지로 열어요.'
                : profile.modeLock === 'scroll'
                  ? '위아래로 이어서 읽어요.'
                  : '한 화면씩 넘겨요.'
            }
            control={
              <Segmented
                label="읽기 방식"
                value={profile.modeLock}
                options={[
                  { value: 'auto', label: '자동' },
                  { value: 'scroll', label: '스크롤' },
                  { value: 'paginated', label: '페이지' },
                ]}
                onChange={(modeLock) => updateProfile({ modeLock })}
              />
            }
          />
          {profile.modeLock !== 'scroll' && (
            <>
              <Pref
                stacked
                title="한 화면에"
                help="두 쪽은 넓은 화면에서만 보여요."
                control={
                  <Segmented
                    label="한 화면에 보일 쪽 수"
                    value={profile.pageSpread}
                    options={[
                      { value: 'single', label: '한 쪽' },
                      { value: 'double', label: '두 쪽' },
                      { value: 'auto', label: '화면에 맞춤' },
                    ]}
                    onChange={(pageSpread) => updateProfile({ pageSpread })}
                  />
                }
              />
              <Pref
                stacked
                title="넘김 효과"
                control={
                  <Segmented
                    label="넘김 효과"
                    value={profile.pageTurnMotion}
                    options={[
                      { value: 'instant', label: '바로' },
                      { value: 'smooth', label: '부드럽게' },
                      { value: 'page', label: '책장 넘김' },
                    ]}
                    onChange={(pageTurnMotion) => updateProfile({ pageTurnMotion })}
                  />
                }
              />
            </>
          )}
        </PrefGroup>
      </PrefSection>
    </>
  );
}
