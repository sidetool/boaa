import { useEffect, useRef, useState } from 'react';
import { cx } from '../components/primitives';

/**
 * Clamped work description. When it is cut off, the text itself is the control: a tap opens it in place,
 * another tap folds it back. 더보기 / 접기 stays visible so the affordance is never hidden.
 */
export function Synopsis({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 2);
    measure();
    // Width changes (rotation, side panels) change where the text breaks.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text]);
  const expandable = clamped || open;
  const toggle = () => expandable && setOpen((value) => !value);
  return (
    <div className={cx('un-detail-synopsis', expandable && 'is-expandable', open && 'is-open')}>
      <p
        ref={ref}
        className={cx(open && 'is-open')}
        aria-label="작품 설명"
        {...(expandable
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: toggle,
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle();
              },
            }
          : {})}
      >
        {text}
      </p>
      {expandable && (
        <button type="button" aria-hidden="true" tabIndex={-1} onClick={toggle}>
          {open ? '접기' : '더보기'}
        </button>
      )}
    </div>
  );
}
