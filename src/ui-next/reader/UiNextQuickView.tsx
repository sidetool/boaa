import { ChevronRight, Minus, Plus, X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import type { ReadingProfile } from '../../domain/types';
import type { ReaderQuickViewProps } from '../../features/reader/reader-quick-view-contract';
import { READING_PROFILE_LIMITS } from '../../features/reader-settings/reading-profile';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { cx, Segmented, Switch } from '../components/primitives';
import './quick-view.css';

type Props = ReaderQuickViewProps;

const THEMES: readonly { id: ReadingProfile['theme']; label: string; bg: string; fg: string }[] = [
  { id: 'light', label: '밝게', bg: '#f5f2e9', fg: '#2a2723' },
  { id: 'sepia', label: '세피아', bg: '#eadfca', fg: '#4a3b28' },
  { id: 'dark', label: '어둡게', bg: '#242321', fg: '#dcd8d0' },
  { id: 'midnight', label: '밤', bg: '#151923', fg: '#c3cbdb' },
];
const MARGINS = [
  { value: '4', label: '좁게' },
  { value: '12', label: '보통' },
  { value: '20', label: '넓게' },
] as const;

const round = (value: number, step: number) => Math.round(value / step) * step;

function Stepper({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  small,
  large,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  small: ReactNode;
  large: ReactNode;
}) {
  const set = (next: number) => onChange(Math.min(max, Math.max(min, round(next, step))));
  return (
    <div className="un-quick-stepper" role="group" aria-label={label}>
      <button type="button" disabled={value <= min} onClick={() => set(value - step)} aria-label={`${label} 줄이기`}>
        {small}
      </button>
      <output aria-live="polite">{display}</output>
      <button type="button" disabled={value >= max} onClick={() => set(value + step)} aria-label={`${label} 키우기`}>
        {large}
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="un-quick-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** ui-next 보기: a low panel that leaves the page visible, so every change can be judged on the text itself. */
export function UiNextQuickView(props: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const { profile, readingFlow, onUpdate } = props;
  useDismissibleLayer({ open: props.open, modal: false, containerRef: panelRef, onClose: props.onClose });
  if (!props.open) return null;
  const font = profile.fontId === 'builtin-sans' ? 'sans' : profile.fontId === 'builtin-serif' ? 'serif' : 'custom';
  const margin = MARGINS.find((option) => Number(option.value) === profile.marginX)?.value;
  const save = props.saveState;

  return (
    <div
      className="ui-next un-quick-layer"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section ref={panelRef} className="un-quick" role="dialog" aria-labelledby={titleId} tabIndex={-1}>
        <span className="un-sheet-grabber" aria-hidden="true" />
        <header className="un-quick-head">
          <h2 id={titleId}>보기</h2>
          <small role={save?.error ? 'alert' : 'status'}>
            {save?.error ? (
              <button type="button" onClick={props.onRetrySave}>
                저장 실패 · 다시 시도
              </button>
            ) : save?.saving || save?.dirty ? (
              '저장 중…'
            ) : (
              ''
            )}
          </small>
          <button type="button" className="un-icon-btn is-sm" onClick={props.onClose} aria-label="보기 설정 닫기">
            <X size={18} />
          </button>
        </header>

        <div className="un-quick-themes" role="radiogroup" aria-label="테마">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={profile.theme === theme.id}
              className={cx(profile.theme === theme.id && 'is-active')}
              onClick={() => onUpdate({ theme: theme.id })}
            >
              <span style={{ background: theme.bg, color: theme.fg }} aria-hidden="true">
                가
              </span>
              {theme.label}
            </button>
          ))}
        </div>

        <div className="un-quick-steppers">
          <Stepper
            label="글자 크기"
            value={profile.fontSize}
            display={`${profile.fontSize}`}
            min={READING_PROFILE_LIMITS.fontSize.min}
            max={READING_PROFILE_LIMITS.fontSize.max}
            step={1}
            onChange={(fontSize) => onUpdate({ fontSize })}
            small={<span className="un-quick-glyph is-sm">가</span>}
            large={<span className="un-quick-glyph is-lg">가</span>}
          />
          <Stepper
            label="줄 간격"
            value={profile.lineHeight}
            display={profile.lineHeight.toFixed(2).replace(/0$/, '')}
            min={READING_PROFILE_LIMITS.lineHeight.min}
            max={READING_PROFILE_LIMITS.lineHeight.max}
            step={0.05}
            onChange={(lineHeight) => onUpdate({ lineHeight })}
            small={<Minus size={16} />}
            large={<Plus size={16} />}
          />
        </div>

        <Row label="글꼴">
          <Segmented
            label="글꼴"
            value={font}
            options={[
              { value: 'serif', label: <span className="un-quick-serif">명조</span> },
              { value: 'sans', label: '고딕' },
              ...(font === 'custom' ? [{ value: 'custom' as const, label: '내 글꼴' }] : []),
            ]}
            onChange={(value) => value !== 'custom' && onUpdate({ fontId: `builtin-${value}` })}
          />
        </Row>
        <Row label="여백">
          <Segmented
            label="좌우 여백"
            value={margin ?? ''}
            options={MARGINS}
            onChange={(value) => onUpdate({ marginX: Number(value) })}
          />
        </Row>
        <Row label="넘김">
          <Segmented
            label="읽기 방식"
            value={readingFlow}
            options={[
              { value: 'scroll', label: '스크롤' },
              { value: 'paginated', label: '페이지' },
            ]}
            onChange={(flow) => onUpdate({ modeLock: flow, flow })}
          />
        </Row>
        {readingFlow === 'paginated' && (
          <Row label="펼침">
            <Segmented
              label="페이지 펼침"
              value={profile.pageSpread}
              options={[
                { value: 'single', label: '한 쪽' },
                { value: 'double', label: '두 쪽' },
                { value: 'auto', label: '자동' },
              ]}
              onChange={(pageSpread) => onUpdate({ pageSpread })}
            />
          </Row>
        )}

        <footer className="un-quick-foot">
          <label className="un-quick-scope">
            <Switch label="이 작품에만 적용" checked={props.bookOverrideEnabled} onChange={props.onSetBookOverride} />
            <span>이 작품에만 적용</span>
          </label>
          <button
            type="button"
            className="un-quick-all"
            onClick={() => {
              props.onClose();
              props.onOpenAllSettings();
            }}
          >
            전체 설정 <ChevronRight size={16} aria-hidden="true" />
          </button>
        </footer>
      </section>
    </div>
  );
}
