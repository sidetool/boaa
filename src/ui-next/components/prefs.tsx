import { AlertCircle, ChevronDown, ChevronRight, Info, Minus, Plus, RotateCcw, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cx, Switch } from './primitives';
import './prefs.css';

/**
 * Building blocks for settings and management screens: grouped rows on a soft surface, one control per row.
 * Screens assemble these instead of styling their own, so every settings page reads the same.
 */

/** A titled block of rows. `action` sits at the end of the title line (e.g. 모두 지우기). */
export function PrefSection({
  title,
  hint,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={cx('un-pref-section', className)} aria-labelledby={title ? id : undefined}>
      {(title || action) && (
        <header className="un-pref-section-head">
          <div>
            {title && <h3 id={id}>{title}</h3>}
            {hint && <p>{hint}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Rows on one surface, divided by hairlines. */
export function PrefGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('un-pref-group', className)}>{children}</div>;
}

/**
 * One setting: label and help on the left, a compact control on the right. `stacked` puts the control under
 * the text, for chips, segmented choices and sliders that need the full width.
 */
export function Pref({
  title,
  help,
  control,
  children,
  stacked,
  disabled,
}: {
  title: ReactNode;
  help?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={cx('un-pref', stacked && 'is-stacked', disabled && 'is-disabled')}>
      <div className="un-pref-text">
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </div>
      {control && <div className="un-pref-control">{control}</div>}
      {children}
    </div>
  );
}

export function PrefSwitch({
  title,
  help,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  help?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <Pref
      title={title}
      help={help}
      disabled={disabled}
      control={<Switch label={title} checked={checked} disabled={disabled} onChange={onChange} />}
    />
  );
}

/** Few short choices as pills; wraps on narrow screens. */
export function PrefChips<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <div className="un-pref-chips" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={cx('un-chip', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Longer choices with a line of explanation each, e.g. themes or modes. */
export function PrefOptions<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; hint?: ReactNode; leading?: ReactNode }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  return (
    <div className="un-pref-options" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={cx('un-pref-option', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.leading && <span className="un-pref-option-leading">{option.leading}</span>}
          <span className="un-pref-option-text">
            <b>{option.label}</b>
            {option.hint && <small>{option.hint}</small>}
          </span>
          <span className="un-pref-option-mark" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/**
 * A number on a track with − and + for exact steps. `format` renders the value (e.g. `18px`, `185%`);
 * `reset` shows a small undo when the value differs from the default.
 */
export function PrefSlider({
  title,
  help,
  value,
  min,
  max,
  step = 1,
  format = String,
  onChange,
  reset,
  disabled,
}: {
  title: string;
  help?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?(value: number): ReactNode;
  onChange(value: number): void;
  reset?: { value: number; label?: string };
  disabled?: boolean;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next / step) * step));
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cx('un-pref is-stacked un-pref-slider', disabled && 'is-disabled')}>
      <div className="un-pref-slider-head">
        <div className="un-pref-text">
          <strong>{title}</strong>
          {help && <small>{help}</small>}
        </div>
        {reset && reset.value !== value && (
          <button
            type="button"
            className="un-icon-btn is-sm"
            aria-label={reset.label ?? `${title} 기본값으로`}
            disabled={disabled}
            onClick={() => onChange(reset.value)}
          >
            <RotateCcw size={15} />
          </button>
        )}
        <output className="un-pref-slider-value">{format(value)}</output>
      </div>
      <div className="un-pref-slider-row">
        <button
          type="button"
          className="un-icon-btn is-sm"
          aria-label={`${title} 줄이기`}
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          <Minus size={16} />
        </button>
        <input
          type="range"
          className="un-range"
          aria-label={title}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          style={{ '--un-range-fill': `${percent}%` } as React.CSSProperties}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
        />
        <button
          type="button"
          className="un-icon-btn is-sm"
          aria-label={`${title} 늘리기`}
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}

/** A row that opens something: a sub-page, a sheet or an external action. `value` shows the current state. */
export function PrefLink({
  title,
  help,
  value,
  icon,
  onClick,
  danger,
  disabled,
}: {
  title: ReactNode;
  help?: ReactNode;
  value?: ReactNode;
  icon?: ReactNode;
  onClick(): void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx('un-pref un-pref-link', danger && 'is-danger')}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && (
        <span className="un-pref-link-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="un-pref-text">
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </span>
      {value !== undefined && <span className="un-pref-link-value">{value}</span>}
      <ChevronRight size={18} className="un-pref-link-chevron" aria-hidden="true" />
    </button>
  );
}

/** A labelled text field with help or an error under it. Pass the input (or select) as the child. */
export function PrefField({
  label,
  help,
  error,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={cx('un-pref is-stacked un-pref-field', Boolean(error) && 'has-error')}>
      <span className="un-pref-text">
        <strong>{label}</strong>
      </span>
      {children}
      {error ? (
        <small className="un-pref-field-error" role="alert">
          {error}
        </small>
      ) : (
        help && <small className="un-pref-field-help">{help}</small>
      )}
    </label>
  );
}

/** Rarely changed rows behind a fold. */
export function PrefFold({
  title,
  summary,
  children,
  defaultOpen,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="un-pref-fold" open={defaultOpen}>
      <summary>
        {title}
        {summary && <small>{summary}</small>}
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}

const NOTICE_ICON = { info: Info, warning: TriangleAlert, danger: AlertCircle } as const;

/** Inline message inside a page. Errors announce themselves; info stays quiet. */
export function Notice({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger';
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div className={cx('un-notice', `is-${tone}`)} role={tone === 'info' ? 'note' : 'alert'}>
      <Icon size={17} aria-hidden="true" />
      <div className="un-notice-text">{children}</div>
      {action}
    </div>
  );
}

/** Nothing to show yet. Keep `body` to one sentence; `action` is the one next step. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="un-state">
      {icon && <span className="un-state-icon">{icon}</span>}
      <b>{title}</b>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

/** Placeholder rows while a list loads. */
export function PrefSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="un-pref-group un-pref-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="un-pref">
          <span className="un-pref-text">
            <i />
            <i />
          </span>
        </div>
      ))}
    </div>
  );
}
