import { peekBookCover, useBookCover } from './use-book-cover';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Novel } from '../../domain/types';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';

export interface BookCoverProps {
  readonly novel: Novel;
  readonly className: string;
  readonly children?: ReactNode;
}

const formatLabels: Record<NonNullable<Novel['format']>, string> = {
  txt: 'TEXT',
  markdown: 'MARKDOWN',
  epub: 'EPUB',
  pdf: 'PDF',
  image_archive: 'COMIC',
};

function FallbackCover({ novel }: { readonly novel: Novel }) {
  return (
    <span className="book-cover-fallback" aria-hidden="true">
      <span className="book-cover-format">{novel.format ? formatLabels[novel.format] : 'BOAA'}</span>
      <strong>{novel.title}</strong>
      <small>{novel.author || 'BOAA LIBRARY'}</small>
    </span>
  );
}

function ResolvedCoverImage({ novel }: { readonly novel: Novel }) {
  const runtime = useOptionalAppRuntime();
  const repository = runtime?.readerRuntime.bookAssetRepository;
  const url = useBookCover(novel, repository);

  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      style={{
        objectFit: novel.coverFit === 'contain' ? 'contain' : 'cover',
        objectPosition: `${novel.coverPositionX ?? 50}% ${novel.coverPositionY ?? 50}%`,
      }}
    />
  ) : (
    <FallbackCover novel={novel} />
  );
}

export function BookCover({ novel, className, children }: BookCoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const runtime = useOptionalAppRuntime();
  const [shouldLoad, setShouldLoad] = useState(
    () =>
      !!peekBookCover(novel, runtime?.readerRuntime.bookAssetRepository) ||
      typeof globalThis.IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (shouldLoad || !novel.coverAssetId) return;
    const root = rootRef.current;
    if (!root || typeof globalThis.IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [novel.coverAssetId, shouldLoad]);

  return (
    <div ref={rootRef} className={className}>
      {novel.coverAssetId && shouldLoad ? (
        <ResolvedCoverImage key={`${novel.id}:${novel.coverAssetId}:${novel.coverContentHash}`} novel={novel} />
      ) : (
        <FallbackCover novel={novel} />
      )}
      {children}
    </div>
  );
}
