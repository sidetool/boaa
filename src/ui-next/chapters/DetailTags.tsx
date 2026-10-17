import { useEffect, useRef, useState } from 'react';
import { cx } from '../components/primitives';

/**
 * Work tags. Phones show one line; when some tags do not fit, a tap on the line lays them all out and another
 * tap folds them back, like the description. Wide screens already wrap everything, so nothing is clickable.
 */
export function DetailTags({ tags }: { tags: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [tags]);
  const expandable = clipped || open;
  const toggle = () => expandable && setOpen((value) => !value);
  return (
    <div
      ref={ref}
      className={cx('un-detail-tags', expandable && 'is-expandable', open && 'is-open')}
      aria-label="작품 태그"
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
      {tags.map((tag) => (
        <span key={tag}>#{tag}</span>
      ))}
    </div>
  );
}
