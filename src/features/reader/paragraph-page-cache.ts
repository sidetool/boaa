import type { Paragraph, ParagraphPage } from '../../domain/types';
import { pruneReaderParagraphCache } from '../../reader/page-cache-policy';

export type ParagraphPageLoader = (chapterId: string, pageIndex: number) => Promise<ParagraphPage | undefined>;

export interface ParagraphPageCacheSnapshot {
  readonly generation: number;
  readonly revision: number;
}

export class ParagraphPageCache {
  private readonly paragraphs = new Map<number, Paragraph>();
  private readonly paragraphIndexById = new Map<string, number>();
  private readonly loadedPages = new Set<number>();
  private readonly failedPages = new Set<number>();
  private readonly loadingPages = new Map<number, Promise<void>>();
  private generation = 0;
  private revision = 0;
  private disposed = false;
  private prefetchQueue: number[] = [];
  private prefetching = false;

  constructor(
    private readonly paragraphsPerPage: number,
    private readonly onChange: () => void,
  ) {}

  /** Seed a newly allocated cache before its first render; never notify during render. */
  seed(pageIndex: number, page: ParagraphPage): void {
    if (this.disposed || this.loadedPages.has(pageIndex)) return;
    for (const paragraph of page.paragraphs) {
      this.paragraphs.set(paragraph.index - 1, paragraph);
      this.paragraphIndexById.set(paragraph.id, paragraph.index - 1);
    }
    this.loadedPages.add(pageIndex);
  }

  snapshot(): ParagraphPageCacheSnapshot {
    return { generation: this.generation, revision: this.revision };
  }

  reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.prefetchQueue = [];
    this.paragraphs.clear();
    this.paragraphIndexById.clear();
    this.loadedPages.clear();
    this.failedPages.clear();
    this.loadingPages.clear();
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.prefetchQueue = [];
    this.paragraphs.clear();
    this.paragraphIndexById.clear();
    this.loadedPages.clear();
    this.failedPages.clear();
    this.loadingPages.clear();
  }

  paragraphAt(index: number): Paragraph | undefined {
    return this.paragraphs.get(index);
  }

  paragraphById(paragraphId: string): Paragraph | undefined {
    const index = this.paragraphIndexById.get(paragraphId);
    return index === undefined ? undefined : this.paragraphs.get(index);
  }

  isPageFailed(pageIndex: number): boolean {
    return this.failedPages.has(pageIndex);
  }

  async loadIndexes(
    chapterId: string,
    paragraphIndexes: readonly number[],
    loader: ParagraphPageLoader,
  ): Promise<void> {
    const pageIndexes = [
      ...new Set(
        paragraphIndexes.filter((index) => index >= 0).map((index) => Math.floor(index / this.paragraphsPerPage)),
      ),
    ];
    await Promise.all(pageIndexes.map((pageIndex) => this.loadPage(chapterId, pageIndex, loader)));
  }

  prefetchIndexes(chapterId: string, indexes: readonly number[], loader: ParagraphPageLoader): void {
    if (this.disposed) return;
    // Replace stale destinations during fast scrolling; only one speculative
    // source request runs at a time. Foreground loads never join this queue.
    this.prefetchQueue = [...new Set(indexes.map((index) => Math.floor(index / this.paragraphsPerPage)))];
    if (this.prefetching) return;
    this.prefetching = true;
    const warm = async () => {
      try {
        while (!this.disposed && this.prefetchQueue.length) {
          const pageIndex = this.prefetchQueue.shift()!;
          await this.loadPage(chapterId, pageIndex, loader, true);
        }
      } finally {
        this.prefetching = false;
      }
    };
    void warm();
  }

  async retryPage(chapterId: string, pageIndex: number, loader: ParagraphPageLoader): Promise<void> {
    if (this.failedPages.delete(pageIndex)) this.changed();
    this.loadedPages.delete(pageIndex);
    await this.loadPage(chapterId, pageIndex, loader);
  }

  prune(visibleParagraphIndexes: readonly number[]): void {
    const result = pruneReaderParagraphCache({
      paragraphCache: this.paragraphs,
      loadedPageIndexes: this.loadedPages,
      failedPageIndexes: this.failedPages,
      visibleParagraphIndexes: [...visibleParagraphIndexes],
      paragraphsPerPage: this.paragraphsPerPage,
    });
    if (!result.changed) return;

    this.paragraphIndexById.clear();
    for (const [index, paragraph] of this.paragraphs) this.paragraphIndexById.set(paragraph.id, index);
    this.changed();
  }

  private loadPage(
    chapterId: string,
    pageIndex: number,
    loader: ParagraphPageLoader,
    speculative = false,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadedPages.has(pageIndex) || this.failedPages.has(pageIndex)) return Promise.resolve();
    const activeLoad = this.loadingPages.get(pageIndex);
    if (activeLoad) {
      if (speculative) return activeLoad;
      const generation = this.generation;
      return activeLoad.then(() => {
        if (
          !this.disposed &&
          generation === this.generation &&
          !this.loadedPages.has(pageIndex) &&
          !this.failedPages.has(pageIndex)
        ) {
          this.failedPages.add(pageIndex);
          this.changed();
        }
      });
    }

    const requestedGeneration = this.generation;
    const load = loader(chapterId, pageIndex)
      .then((page) => {
        if (this.disposed || requestedGeneration !== this.generation) return;
        if (!page) {
          if (speculative) return;
          this.failedPages.add(pageIndex);
          this.changed();
          return;
        }

        let changed = false;
        for (const paragraph of page.paragraphs) {
          const index = paragraph.index - 1;
          if (this.paragraphs.get(index) !== paragraph) {
            this.paragraphs.set(index, paragraph);
            this.paragraphIndexById.set(paragraph.id, index);
            changed = true;
          }
        }
        this.loadedPages.add(pageIndex);
        changed = this.failedPages.delete(pageIndex) || changed;
        if (changed) this.changed();
      })
      .catch(() => {
        if (this.disposed || requestedGeneration !== this.generation || speculative) return;
        this.failedPages.add(pageIndex);
        this.changed();
      })
      .finally(() => {
        if (requestedGeneration === this.generation) this.loadingPages.delete(pageIndex);
      });
    this.loadingPages.set(pageIndex, load);
    return load;
  }

  private changed(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.onChange();
  }
}
