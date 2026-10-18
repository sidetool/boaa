import type { Chapter } from '../domain/types';

export function nextPlaybackChapter(chapters: readonly Chapter[], currentChapterId: string): Chapter | undefined {
  const ordered = [...chapters].sort((left, right) => left.index - right.index);
  const currentIndex = ordered.findIndex((chapter) => chapter.id === currentChapterId);
  return currentIndex >= 0 ? ordered[currentIndex + 1] : undefined;
}

export interface PendingChapterPlayback {
  readonly bookId: string;
  readonly chapterId: string;
  readonly startIndex: number;
  readonly queueItemFingerprint?: string;
}

export class BookPlaybackCoordinator {
  private generation = 0;
  private pending?: PendingChapterPlayback;

  schedule(target: PendingChapterPlayback): number {
    this.pending = target;
    this.generation += 1;
    return this.generation;
  }

  take(bookId: string, chapterId: string): PendingChapterPlayback | undefined {
    if (this.pending?.bookId !== bookId || this.pending.chapterId !== chapterId) return undefined;
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  cancel(): void {
    this.pending = undefined;
    this.generation += 1;
  }

  get currentGeneration(): number {
    return this.generation;
  }
}

/** Consume only when the deferred start runs, so a render/StrictMode cleanup cannot lose the request. */
export function deferChapterPlayback(
  coordinator: BookPlaybackCoordinator,
  bookId: string,
  chapterId: string,
  start: (pending: PendingChapterPlayback) => void,
): () => void {
  let cancelled = false;
  const generation = coordinator.currentGeneration;
  queueMicrotask(() => {
    if (cancelled || generation !== coordinator.currentGeneration) return;
    const pending = coordinator.take(bookId, chapterId);
    if (pending) start(pending);
  });
  return () => {
    cancelled = true;
  };
}
