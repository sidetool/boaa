import { BookOpen, ChevronDown, Columns2, GalleryVertical, RectangleVertical, ScrollText, X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { ComicReadingProfile } from '../../domain/types';
import type { ComicViewMode } from '../../features/fixed-document/comic-layout';
import { SettingsSlider } from '../../features/reader-settings/SettingsSlider';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { cx, Segmented, Switch } from '../components/primitives';
import './comic-settings.css';

export interface UiNextComicSettingsProps {
  readonly viewMode: ComicViewMode;
  readonly profile: ComicReadingProfile;
  readonly narrow: boolean;
  readonly pageIndex: number;
  readonly totalPages: number;
  readonly crop: {
    readonly progress?: { current: number; total: number; detected: number };
    readonly status: 'idle' | 'running' | 'failed';
    readonly failedPages: number;
    run(indexes: readonly number[]): void;
    cancel(): void;
  };
  onViewMode(mode: ComicViewMode): void;
  onFit(fit: ComicReadingProfile['fit']): void;
  update(change: Partial<ComicReadingProfile>): void;
  onClose(): void;
}

const MODES: readonly { value: ComicViewMode; label: string; icon: ReactNode }[] = [
  { value: 'single', label: '한 쪽', icon: <RectangleVertical size={22} /> },
  { value: 'spread', label: '두 쪽', icon: <Columns2 size={22} /> },
  { value: 'continuous', label: '세로 스크롤', icon: <ScrollText size={22} /> },
  { value: 'continuous-seamless', label: '웹툰', icon: <GalleryVertical size={22} /> },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="un-comic-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** ui-next 만화 보기: a low sheet over the page; layout first, rarely used adjustments folded below. */
export function UiNextComicSettings(props: UiNextComicSettingsProps) {
  const { profile, viewMode, update } = props;
  const panelRef = useRef<HTMLElement>(null);
  useDismissibleLayer({ open: true, modal: false, containerRef: panelRef, onClose: props.onClose });
  const vertical = viewMode === 'continuous' || viewMode === 'continuous-seamless';
  const tuned =
    profile.brightness !== 1 ||
    profile.contrast !== 1 ||
    profile.saturation !== 1 ||
    profile.grayscale ||
    profile.invert;

  return (
    <section ref={panelRef} className="un-comic-sheet" role="dialog" aria-label="만화 보기 설정" tabIndex={-1}>
      <span className="un-sheet-grabber" aria-hidden="true" />
      <header className="un-comic-head">
        <h2>보기</h2>
        <button type="button" className="un-icon-btn is-sm" onClick={props.onClose} aria-label="만화 보기 설정 닫기">
          <X size={18} />
        </button>
      </header>

      <div className="un-comic-modes" role="radiogroup" aria-label="보기 방식">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={viewMode === mode.value}
            className={cx(viewMode === mode.value && 'is-active')}
            onClick={() => props.onViewMode(mode.value)}
          >
            {mode.icon}
            {mode.label}
          </button>
        ))}
      </div>
      {viewMode === 'spread' && props.narrow && (
        <p className="un-comic-note">좁은 화면에서는 잘리지 않게 한 쪽씩 보여 줘요.</p>
      )}

      {!vertical && (
        <Row label="넘기는 방향">
          <Segmented
            label="넘기는 방향"
            value={profile.direction}
            options={[
              { value: 'ltr', label: '왼쪽부터' },
              { value: 'rtl', label: '오른쪽부터 (만화)' },
            ]}
            onChange={(direction) => update({ direction })}
          />
        </Row>
      )}
      <Row label="화면 맞춤">
        <Segmented
          label="화면 맞춤"
          value={profile.fit}
          options={[
            { value: 'page', label: '전체' },
            { value: 'width', label: '너비' },
            { value: 'height', label: '높이' },
            { value: 'original', label: '원본' },
          ]}
          onChange={props.onFit}
        />
      </Row>
      {!vertical && (
        <Row label="넘김 효과">
          <Segmented
            label="페이지 전환"
            value={profile.pageTurnMotion ?? 'slide'}
            options={[
              { value: 'instant', label: '없음' },
              { value: 'slide', label: '밀기' },
              { value: 'page', label: '책장' },
            ]}
            onChange={(pageTurnMotion) => update({ pageTurnMotion })}
          />
        </Row>
      )}
      {viewMode === 'spread' && (
        <>
          <Row label="표지">
            <Segmented
              label="표지"
              value={profile.coverBehavior}
              options={[
                { value: 'single', label: '단독' },
                { value: 'paired', label: '함께 펼침' },
              ]}
              onChange={(coverBehavior) => update({ coverBehavior })}
            />
          </Row>
          <Row label="첫 페이지 면">
            <Segmented
              label="첫 페이지 면"
              value={profile.pageParity}
              options={[
                { value: 'auto', label: '자동' },
                { value: 'left', label: '왼쪽' },
                { value: 'right', label: '오른쪽' },
              ]}
              onChange={(pageParity) => update({ pageParity })}
            />
          </Row>
        </>
      )}
      {viewMode === 'continuous' && (
        <Row label="페이지 간격">
          <Segmented
            label="페이지 간격"
            value={String(profile.gap ?? 8) as '0' | '8' | '24'}
            options={[
              { value: '0', label: '없음' },
              { value: '8', label: '좁게' },
              { value: '24', label: '넓게' },
            ]}
            onChange={(gap) => update({ gap: Number(gap) })}
          />
        </Row>
      )}
      <Row label="배경">
        <div className="un-comic-swatches" role="radiogroup" aria-label="배경">
          {(
            [
              ['black', '검정'],
              ['charcoal', '짙은 회색'],
              ['white', '흰색'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={(profile.background ?? 'charcoal') === value}
              aria-label={label}
              title={label}
              className={cx(`is-${value}`, (profile.background ?? 'charcoal') === value && 'is-active')}
              onClick={() => update({ background: value })}
            />
          ))}
        </div>
      </Row>

      <details className="un-comic-fold">
        <summary>
          화면 보정{tuned && <em>적용 중</em>}
          <ChevronDown size={18} aria-hidden="true" />
        </summary>
        <div className="un-comic-fold-body">
          {(
            [
              ['brightness', '밝기', 40, 180],
              ['contrast', '대비', 40, 200],
              ['saturation', '채도', 0, 200],
            ] as const
          ).map(([key, label, min, max]) => (
            <SettingsSlider
              key={key}
              label={label}
              min={min}
              max={max}
              step={1}
              suffix="%"
              value={Math.round(profile[key] * 100)}
              onChange={(value) => update({ [key]: value / 100 })}
            />
          ))}
          <div className="un-comic-switches">
            <label>
              <Switch label="흑백" checked={profile.grayscale} onChange={(grayscale) => update({ grayscale })} />
              흑백
            </label>
            <label>
              <Switch label="색상 반전" checked={profile.invert} onChange={(invert) => update({ invert })} />
              색상 반전
            </label>
            {tuned && (
              <button
                type="button"
                className="un-btn is-text is-sm"
                onClick={() => update({ brightness: 1, contrast: 1, saturation: 1, grayscale: false, invert: false })}
              >
                초기화
              </button>
            )}
          </div>
        </div>
      </details>

      <details className="un-comic-fold">
        <summary>
          여백 자르기{profile.crop !== 'off' && <em>{profile.crop === 'auto' ? '자동' : '직접'}</em>}
          <ChevronDown size={18} aria-hidden="true" />
        </summary>
        <div className="un-comic-fold-body">
          <Segmented
            label="여백 자르기 방식"
            value={profile.crop}
            options={[
              { value: 'off', label: '안 함' },
              { value: 'auto', label: '페이지마다 자동' },
              { value: 'manual', label: '직접 지정' },
            ]}
            onChange={(crop) => update({ crop })}
          />
          {profile.crop === 'auto' && (
            <div className="un-comic-crop">
              {props.crop.progress ? (
                <>
                  <span role="status" aria-live="polite">
                    {props.crop.progress.current}/{props.crop.progress.total}쪽 확인 · {props.crop.progress.detected}쪽
                    감지
                  </span>
                  <button type="button" className="un-btn is-text is-sm" onClick={props.crop.cancel}>
                    취소
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    onClick={() => props.crop.run([props.pageIndex])}
                  >
                    {profile.pageCrops?.[String(props.pageIndex)] ? '이 쪽 다시 감지' : '이 쪽 감지'}
                  </button>
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    onClick={() => props.crop.run(Array.from({ length: props.totalPages }, (_, index) => index))}
                  >
                    전체 {props.totalPages.toLocaleString()}쪽 감지
                  </button>
                </>
              )}
              {props.crop.status === 'failed' && (
                <small>
                  {props.crop.failedPages > 0
                    ? `${props.crop.failedPages}쪽은 경계를 찾지 못했어요. 이전 결과는 그대로예요.`
                    : '여백을 분석하지 못했어요.'}
                </small>
              )}
            </div>
          )}
          {profile.crop === 'manual' &&
            (['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <SettingsSlider
                key={side}
                label={{ top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽' }[side]}
                min={0}
                max={20}
                step={1}
                suffix="%"
                value={Math.round((profile.manualCrop?.[side] ?? 0) * 100)}
                onChange={(value) =>
                  update({
                    manualCrop: {
                      ...(profile.manualCrop ?? { top: 0, right: 0, bottom: 0, left: 0 }),
                      [side]: value / 100,
                    },
                  })
                }
              />
            ))}
        </div>
      </details>
      <p className="un-comic-foot">
        <BookOpen size={14} aria-hidden="true" />이 작품에만 적용돼요
      </p>
    </section>
  );
}
