import { useEffect, useState } from 'react';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { SessionCoverCache } from '../../external-sources/session-cover-cache';

const caches = new WeakMap<BookAssetRepository, SessionCoverCache>();
function cacheFor(repository: BookAssetRepository) {
  let cache = caches.get(repository);
  if (!cache) {
    cache = new SessionCoverCache();
    caches.set(repository, cache);
  }
  return cache;
}
export function bookCoverRevision(novel: Pick<Novel, 'coverAssetId' | 'coverContentHash'>) {
  return novel.coverAssetId && novel.coverContentHash ? `${novel.coverAssetId}:${novel.coverContentHash}` : undefined;
}
export function peekBookCover(novel: Novel, repository?: BookAssetRepository) {
  if (!repository || !novel.coverAssetId) return undefined;
  return caches.get(repository)?.peek(JSON.stringify([novel.id, novel.coverAssetId, novel.coverContentHash]));
}
/** Shared object URLs, scoped to the repository; visible consumers pin URLs until unmount. */
export function useBookCover(novel: Novel, repository?: BookAssetRepository) {
  const revision = bookCoverRevision(novel);
  const key = JSON.stringify([novel.id, novel.coverAssetId, novel.coverContentHash]);
  const cache = repository ? cacheFor(repository) : undefined;
  const cached = novel.coverAssetId ? cache?.peek(key) : undefined;
  const [resolved, setResolved] = useState<{ key: string; url?: string; repository?: BookAssetRepository }>();
  useEffect(() => {
    if (!novel.coverAssetId || !cache || !repository) return;
    const abort = new AbortController();
    void cache
      .resolve(key, async () => (await repository.getActiveCover(novel.id, revision))?.blob, abort.signal)
      .then((url) => {
        if (!abort.signal.aborted) setResolved({ key, url, repository });
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [cache, key, novel.id, novel.coverAssetId, repository, revision]);
  return novel.coverAssetId
    ? (cached ?? (resolved?.key === key && resolved.repository === repository ? resolved.url : undefined))
    : undefined;
}
