import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '../components/primitives';

/** 회차 페이지 이동: first, last and the pages around the current one, with gaps shown as `…`. */
export function Pager({ page, count, onPage }: { page: number; count: number; onPage(page: number): void }) {
  if (count <= 1) return null;
  const pages = Array.from({ length: count }, (_, i) => i + 1).filter(
    (value) => value === 1 || value === count || Math.abs(value - page) <= 1,
  );
  return (
    <nav className="un-pager" aria-label="회차 페이지">
      <button
        type="button"
        className="un-icon-btn"
        aria-label="이전 페이지"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={20} />
      </button>
      {pages.map((value, index) => (
        <span key={value}>
          {index > 0 && value - pages[index - 1] > 1 && <i aria-hidden="true">…</i>}
          <button
            type="button"
            className={cx(value === page && 'is-active')}
            aria-current={value === page ? 'page' : undefined}
            aria-label={`${value}페이지`}
            onClick={() => onPage(value)}
          >
            {value}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="un-icon-btn"
        aria-label="다음 페이지"
        disabled={page >= count}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={20} />
      </button>
    </nav>
  );
}
