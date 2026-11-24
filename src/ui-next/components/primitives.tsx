import { Check, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { dismissibleLayerStack } from '../../shared/ui/use-dismissible-layer';
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

/** Arrow keys change a radio value. Settings tabs move focus first and open on Enter or Space. */
export function navigateChoices(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const radio = event.currentTarget.getAttribute('role') === 'radiogroup';
  const previous = event.key === 'ArrowUp' || (radio && event.key === 'ArrowLeft');
  const next = event.key === 'ArrowDown' || (radio && event.key === 'ArrowRight');
  if (!previous && !next && event.key !== 'Home' && event.key !== 'End') return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  let to = (index + (previous ? -1 : 1) + buttons.length) % buttons.length;
  if (event.key === 'Home') to = 0;
  if (event.key === 'End') to = buttons.length - 1;
  buttons[to].focus();
  if (radio && buttons[to].getAttribute('aria-checked') !== 'true') buttons[to].click();
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
  const tabStop = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div className="un-segmented" role="radiogroup" aria-label={label} onKeyDown={navigateChoices}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          tabIndex={index === tabStop ? 0 : -1}
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
let overflowBeforeSheets = '';
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** Shares Tab, Escape and focus ownership between full-screen dialogs and their nested sheets. */
export function useModalFocus(
  panel: RefObject<HTMLElement>,
  open: boolean,
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !panel.current) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!openSheets) overflowBeforeSheets = document.documentElement.style.overflow;
    openSheets += 1;
    document.documentElement.style.overflow = 'hidden';
    const registration = dismissibleLayerStack.register();
    if (!previous || !panel.current.contains(previous))
      (initialFocus?.current ?? panel.current).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      // Only the sheet on top answers: Escape in a rename dialog must not also close the list under it.
      if (!registration.isTop() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        // preventDefault tells Android back that this sheet consumed it, even while closeDisabled holds it open.
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the sheet; focus used to fall through to the page behind it.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current || !panel.current.contains(active))) {
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
      const restoreFocus = registration.isTop();
      registration.release();
      openSheets -= 1;
      if (!openSheets) document.documentElement.style.overflow = overflowBeforeSheets;
      if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, panel, initialFocus]);
}

/** Bottom sheet on phones, side sheet on wide screens (`auto`), or a centered dialog. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  variant = 'auto',
  closeDisabled = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'auto' | 'dialog';
  /** Keeps the sheet up while work that must not be interrupted runs (backdrop, Escape and ✕ do nothing). */
  closeDisabled?: boolean;
  /** Extra class on the sheet panel for content-specific sizing. */
  className?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const requestClose = () => {
    if (!closeDisabled) onClose();
  };

  useModalFocus(panel, open, requestClose);

  if (!open) return null;
  return createPortal(
    <div className={cx('ui-next un-layer', `is-${variant}`)} role="presentation" onClick={requestClose}>
      <section
        ref={panel}
        className={cx('un-sheet', className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        aria-labelledby={title && typeof title !== 'string' ? titleId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="un-sheet-grabber" aria-hidden="true" />
        {title && (
          <header className="un-sheet-head">
            <h2 id={titleId}>{title}</h2>
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
