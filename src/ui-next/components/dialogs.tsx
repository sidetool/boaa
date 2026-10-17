import { useEffect, useRef, useState, type ReactNode } from 'react';
import './prefs.css';
import { cx, Sheet } from './primitives';

/** Yes/no in a centered dialog. `danger` paints the confirm button red for destructive actions. */
export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = '취소',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Sheet
      open={open}
      variant="dialog"
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="un-btn is-ghost" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cx('un-btn', danger ? 'is-danger' : 'is-primary')}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children && <div className="un-dialog-body">{children}</div>}
    </Sheet>
  );
}

/**
 * One text field in a centered dialog, for names. `check` returns a message that blocks saving, or a
 * `warning` that only informs (e.g. an existing name will be replaced).
 */
export function PromptSheet({
  open,
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel,
  maxLength = 60,
  check,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  maxLength?: number;
  check?(value: string): { error?: string; warning?: string } | undefined;
  onSubmit(value: string): void;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(initial);
    const frame = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open, initial]);
  const trimmed = value.trim();
  const verdict = trimmed ? check?.(trimmed) : undefined;
  const blocked = !trimmed || Boolean(verdict?.error);
  const submit = () => {
    if (blocked) return;
    onSubmit(trimmed);
    onClose();
  };
  return (
    <Sheet
      open={open}
      variant="dialog"
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="un-btn is-ghost" onClick={onClose}>
            취소
          </button>
          <button type="button" className="un-btn is-primary" disabled={blocked} onClick={submit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        className="un-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={input}
          className="un-input"
          aria-label={label}
          placeholder={placeholder}
          maxLength={maxLength}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {verdict?.error ? (
          <small className="un-dialog-error" role="alert">
            {verdict.error}
          </small>
        ) : (
          verdict?.warning && <small className="un-dialog-hint">{verdict.warning}</small>
        )}
      </form>
    </Sheet>
  );
}
