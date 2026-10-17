import { Check, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LibraryAction } from '../library/contract';
import '../styles/components.css';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={cx('un-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${percent > 0 ? Math.max(percent, 3) : 0}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="un-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cx(option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

let openSheets = 0;
const sheetStack: symbol[] = [];
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** Bottom sheet on phones, side sheet on wide screens (`auto`), or a centered dialog. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  variant = 'auto',
  closeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'auto' | 'dialog';
  /** Keeps the sheet up while work that must not be interrupted runs (backdrop, Escape and ✕ do nothing). */
  closeDisabled?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = closeDisabled ? () => undefined : onClose;
  const requestClose = () => close.current();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    openSheets += 1;
    document.documentElement.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });
    const self = Symbol('sheet');
    sheetStack.push(self);
    const onKey = (event: KeyboardEvent) => {
      // Only the sheet on top answers: Escape in a rename dialog must not also close the list under it.
      if (sheetStack[sheetStack.length - 1] !== self) return;
      if (event.key === 'Escape') {
        // preventDefault tells Android back that this sheet consumed it, even while closeDisabled holds it open.
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the sheet; focus used to fall through to the page behind it.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute('disabled') && element.offsetParent !== null,
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      sheetStack.splice(sheetStack.indexOf(self), 1);
      openSheets -= 1;
      if (!openSheets) document.documentElement.style.overflow = '';
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className={cx('ui-next un-layer', `is-${variant}`)} role="presentation" onClick={requestClose}>
      <section
        ref={panel}
        className="un-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="un-sheet-grabber" aria-hidden="true" />
        {title && (
          <header className="un-sheet-head">
            <h2>{title}</h2>
            <button
              type="button"
              className="un-icon-btn"
              aria-label="닫기"
              disabled={closeDisabled}
              onClick={requestClose}
            >
              <X size={20} />
            </button>
          </header>
        )}
        <div className="un-sheet-body">{children}</div>
        {footer && <footer className="un-sheet-foot">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

export type ActionEntry = (LibraryAction & { icon?: ReactNode; detail?: ReactNode }) | 'divider';

/** Renders adapter commands. Disabled commands stay visible so the reader learns they exist. */
export function ActionList({ actions, onDone }: { actions: readonly ActionEntry[]; onDone: () => void }) {
  return (
    <div className="un-action-list">
      {actions.map((action, index) =>
        action === 'divider' ? (
          <hr key={`divider-${index}`} />
        ) : (
          <button
            key={action.id}
            type="button"
            className={cx('un-action', action.danger && 'is-danger')}
            disabled={action.disabled}
            aria-checked={action.selected === undefined ? undefined : action.selected}
            role={action.selected === undefined ? undefined : 'menuitemradio'}
            onClick={() => {
              onDone();
              void action.run();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
            {action.detail !== undefined && <small>{action.detail}</small>}
            {action.selected && <Check size={18} className="un-action-check" />}
          </button>
        ),
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('un-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
