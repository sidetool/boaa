import { invalidateReaderPositionPersistence } from './reader-progress-controller';
import { invalidateBookWorkspaceReaderArtifacts } from '../book-workspace/book-workspace-reader-artifacts';
import type { ParagraphPage } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';

const PAGE_LIMIT = 64;
interface Entry {
  readonly chapterId: string;
  page?: ParagraphPage;
  readonly pending: Promise<ParagraphPage | undefined>;
}
// Repository identity is part of the scope: equal revision/chapter IDs on two
// accounts or backends must never share text. Weak ownership releases the cache
// when its repository is discarded.
const repositories = new WeakMap<ReaderBodyRepository, Map<string, Entry>>();

export function loadSharedParagraphPage(
  repository: ReaderBodyRepository,
  contentRevisionId: string,
  chapterId: string,
  pageIndex: number,
): Promise<ParagraphPage | undefined> {
  let pages = repositories.get(repository);
  if (!pages) repositories.set(repository, (pages = new Map()));
  const key = JSON.stringify([contentRevisionId, chapterId, pageIndex]);
  const cached = pages.get(key);
  if (cached) {
    pages.delete(key);
    pages.set(key, cached);
    return cached.pending;
  }
  const cache = pages;
  const entry: Entry = {
    chapterId,
    pending: repository.getParagraphPage(chapterId, pageIndex).then(
      (page) => {
        // Full repository invalidation is an auth epoch boundary, including
        // consumers still awaiting an old session response.
        if (repositories.get(repository) !== cache) throw new DOMException('Reader session changed', 'AbortError');
        // Missing pages and failures remain retryable; invalidated/evicted loads
        // never repopulate the cache after finishing.
        if (!page && cache.get(key) === entry) cache.delete(key);
        if (page && cache.get(key) === entry) entry.page = page;
        return page;
      },
      (error: unknown) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    ),
  };
  cache.set(key, entry);
  while (cache.size > PAGE_LIMIT) cache.delete(cache.keys().next().value!);
  return entry.pending;
}

/** Synchronous, revision/account-scoped snapshot for an already prepared opening page. */
export function peekSharedParagraphPage(
  repository: ReaderBodyRepository,
  revision: string,
  chapterId: string,
  pageIndex: number,
): ParagraphPage | undefined {
  return repositories.get(repository)?.get(JSON.stringify([revision, chapterId, pageIndex]))?.page;
}

export function invalidateSharedParagraphPages(repository: ReaderBodyRepository, chapterId?: string): void {
  invalidateBookWorkspaceReaderArtifacts(repository, chapterId);
  if (chapterId === undefined) {
    invalidateReaderPositionPersistence(repository);
    repositories.delete(repository);
    return;
  }
  const pages = repositories.get(repository);
  if (!pages) return;
  for (const [key, entry] of pages) {
    if (entry.chapterId === chapterId) pages.delete(key);
  }
}
