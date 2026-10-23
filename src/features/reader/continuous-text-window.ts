import type { Chapter, Paragraph } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { ParagraphPageCache } from './paragraph-page-cache';
import { loadSharedParagraphPage } from './shared-paragraph-pages';

export interface ContinuousTextChapter {
  readonly chapter: Chapter;
  readonly repository: ReaderBodyRepository;
}

/** Preparing a neighbor must not navigate, save a visit, or start paid synthesis. */
export interface ContinuousTextSource {
  neighbor(chapterId: string, direction: -1 | 1, signal: AbortSignal): Promise<ContinuousTextChapter | undefined>;
  observed?(chapterId: string): void;
  retain?(chapterIds: readonly string[]): void;
}

export interface ContinuousTextRow {
  readonly entry: ContinuousTextChapter;
  readonly start: number;
  readonly localIndex: number;
  readonly boundary: boolean;
}

/** Runtime row coordinates only. Source chapter/paragraph identities are never rewritten in storage. */
export class ContinuousTextWindow {
  readonly id: string;
  readonly entries: ContinuousTextChapter[];
  private readonly caches = new Map<string, ParagraphPageCache>();
  private readonly controller = new AbortController();
  private readonly pending = new Map<-1 | 1, Promise<void>>();
  private readonly exhausted = new Set<-1 | 1>();
  private readonly errors = new Map<-1 | 1, string>();
  private alive = true;
  private preparingId?: string;
  private trimScheduled = false;
  private readonly projected = new Map<string, { source: Paragraph; index: number; paragraph: Paragraph }>();
  revision = 0;
  constructor(
    initial: ContinuousTextChapter,
    private readonly source: ContinuousTextSource,
    private readonly contentRevision: string,
    private readonly publish: () => void,
  ) {
    this.entries = [initial];
    this.id = `continuous:${initial.chapter.id}`;
  }
  get count(): number {
    return this.entries.reduce((count, { chapter }) => count + chapter.paragraphCount + 1, 0);
  }
  get first(): Chapter {
    return this.entries[0].chapter;
  }
  get last(): Chapter {
    return this.entries[this.entries.length - 1].chapter;
  }
  status(direction: -1 | 1): 'ready' | 'loading' | 'error' | 'end' {
    return this.errors.has(direction)
      ? 'error'
      : this.exhausted.has(direction)
        ? 'end'
        : this.pending.has(direction)
          ? 'loading'
          : 'ready';
  }
  row(index: number): ContinuousTextRow | undefined {
    let start = 0;
    for (const entry of this.entries) {
      const end = start + entry.chapter.paragraphCount;
      if (index >= start && index <= end) return { entry, start, localIndex: index - start, boundary: index === end };
      start = end + 1;
    }
    return undefined;
  }
  index(chapterId: string, localIndex: number): number | undefined {
    let start = 0;
    for (const { chapter } of this.entries) {
      if (chapter.id === chapterId) return start + Math.max(0, Math.min(chapter.paragraphCount - 1, localIndex));
      start += chapter.paragraphCount + 1;
    }
    return undefined;
  }
  key(index: number): string {
    const row = this.row(index);
    return row ? `${row.entry.chapter.id}:${row.boundary ? 'boundary' : row.localIndex}` : `${this.id}:${index}`;
  }
  // TanStack invalidates every row measurement when this function changes.
  // Refresh it only when row identities change, never on page loads or scrolling.
  getItemKey = (index: number): string => this.key(index);
  private updateRowKeys(): void {
    this.getItemKey = (index) => this.key(index);
  }
  private cache(entry: ContinuousTextChapter): ParagraphPageCache {
    let cache = this.caches.get(entry.chapter.id);
    if (!cache) {
      cache = new ParagraphPageCache(PARAGRAPHS_PER_PAGE, () => this.changed());
      this.caches.set(entry.chapter.id, cache);
    }
    return cache;
  }
  private loader(entry: ContinuousTextChapter) {
    return (chapterId: string, page: number) =>
      loadSharedParagraphPage(entry.repository, `${this.contentRevision}:${entry.chapter.textHash}`, chapterId, page);
  }
  paragraphAt(index: number): Paragraph | undefined {
    const row = this.row(index);
    if (!row) return undefined;
    if (row.boundary)
      return {
        id: this.key(index),
        novelId: row.entry.chapter.novelId,
        chapterId: row.entry.chapter.id,
        index: index + 1,
        text: '',
        textHash: '',
        startOffsetInChapter: 0,
        endOffsetInChapter: 0,
      };
    const paragraph = this.caches.get(row.entry.chapter.id)?.paragraphAt(row.localIndex);
    if (!paragraph) return undefined;
    const cached = this.projected.get(paragraph.id);
    if (cached?.source === paragraph && cached.index === index) return cached.paragraph;
    const projected = { ...paragraph, index: index + 1 };
    this.projected.set(paragraph.id, { source: paragraph, index, paragraph: projected });
    return projected;
  }
  original(paragraph: Paragraph): Paragraph {
    const row = this.row(paragraph.index - 1);
    return row && !row.boundary ? { ...paragraph, index: row.localIndex + 1 } : paragraph;
  }
  paragraphById(id: string): Paragraph | undefined {
    for (const [chapterId, cache] of this.caches) {
      const paragraph = cache.paragraphById(id);
      const index = paragraph && this.index(chapterId, paragraph.index - 1);
      if (paragraph && index !== undefined) return { ...paragraph, index: index + 1 };
    }
    return undefined;
  }
  async loadIndexes(indexes: readonly number[]): Promise<void> {
    const grouped = new Map<ContinuousTextChapter, number[]>();
    for (const index of indexes) {
      const row = this.row(index);
      if (!row || row.boundary) continue;
      const group = grouped.get(row.entry) ?? [];
      group.push(row.localIndex);
      grouped.set(row.entry, group);
    }
    await Promise.all(
      [...grouped].map(([entry, local]) => this.cache(entry).loadIndexes(entry.chapter.id, local, this.loader(entry))),
    );
  }
  async getParagraphAt(index: number): Promise<Paragraph | undefined> {
    const row = this.row(index);
    if (!row) return undefined;
    await this.loadIndexes([index]);
    const current = this.index(row.entry.chapter.id, row.localIndex);
    return current === undefined ? undefined : this.paragraphAt(current);
  }
  isPageFailed(page: number): boolean {
    for (let index = page * PARAGRAPHS_PER_PAGE; index < (page + 1) * PARAGRAPHS_PER_PAGE; index++) {
      const row = this.row(index);
      if (
        row &&
        !row.boundary &&
        this.caches.get(row.entry.chapter.id)?.isPageFailed(Math.floor(row.localIndex / PARAGRAPHS_PER_PAGE))
      )
        return true;
    }
    return false;
  }
  async retryPage(page: number): Promise<void> {
    const requests = new Map<string, { entry: ContinuousTextChapter; page: number }>();
    for (let index = page * PARAGRAPHS_PER_PAGE; index < (page + 1) * PARAGRAPHS_PER_PAGE; index++) {
      const row = this.row(index);
      if (row && !row.boundary) {
        const local = Math.floor(row.localIndex / PARAGRAPHS_PER_PAGE);
        requests.set(`${row.entry.chapter.id}:${local}`, { entry: row.entry, page: local });
      }
    }
    await Promise.all(
      [...requests.values()].map(({ entry, page }) =>
        this.cache(entry).retryPage(entry.chapter.id, page, this.loader(entry)),
      ),
    );
  }
  prune(indexes: readonly number[]): void {
    const keep = new Set<string>(this.preparingId ? [this.preparingId] : []);
    for (const index of indexes) {
      const row = this.row(index);
      if (row) keep.add(row.entry.chapter.id);
    }
    for (const [id, cache] of this.caches) {
      if (!keep.has(id)) {
        cache.dispose();
        this.caches.delete(id);
      } else if (id !== this.preparingId)
        cache.prune(
          indexes.flatMap((index) => {
            const row = this.row(index);
            return row?.entry.chapter.id === id && !row.boundary ? [row.localIndex] : [];
          }),
        );
    }
    for (const [id, value] of this.projected)
      if (
        !keep.has(value.source.chapterId) ||
        this.caches.get(value.source.chapterId)?.paragraphById(id) !== value.source
      )
        this.projected.delete(id);
    this.source.retain?.([...keep]);
    if (this.entries.length > 5 && !this.pending.size && !this.trimScheduled && keep.size) {
      const first = this.entries.findIndex((entry) => keep.has(entry.chapter.id));
      let last = first;
      for (let index = first; index < this.entries.length; index++)
        if (keep.has(this.entries[index].chapter.id)) last = index;
      const lower = Math.max(0, first - 1);
      const upper = Math.min(this.entries.length, last + 2);
      if (lower > 0 || upper < this.entries.length) {
        this.trimScheduled = true;
        const current = this.entries.slice();
        queueMicrotask(() => {
          this.trimScheduled = false;
          if (!this.alive || this.pending.size || current.some((entry, index) => this.entries[index] !== entry)) return;
          if (upper < this.entries.length) {
            this.entries.splice(upper);
            this.exhausted.delete(1);
            this.errors.delete(1);
          }
          if (lower > 0) {
            this.entries.splice(0, lower);
            this.exhausted.delete(-1);
            this.errors.delete(-1);
          }
          this.updateRowKeys();
          this.changed();
        });
      }
    }
  }
  prefetchAdjacent(indexes: readonly number[]): void {
    if (!indexes.length) return;
    const last = Math.max(...indexes);
    if (last >= this.count - 16) void this.prepare(1);
    // The chapter opened by the reader remains the start until they scroll back.
    // Prepending on mount exposes an earlier chapter in the heading area and can
    // incorrectly publish that chapter as read without any user movement.
  }
  async prepare(direction: -1 | 1, retry = false): Promise<void> {
    if (!this.alive || this.exhausted.has(direction) || (!retry && this.errors.has(direction))) return;
    const existing = this.pending.get(direction);
    if (existing) return existing;
    if (this.pending.size) return;
    this.errors.delete(direction);
    const origin = direction === 1 ? this.last : this.first;
    const operation = Promise.resolve()
      .then(() => this.source.neighbor(origin.id, direction, this.controller.signal))
      .then(async (entry) => {
        if (!this.alive) return;
        if (!entry || this.entries.some((value) => value.chapter.id === entry.chapter.id)) {
          this.exhausted.add(direction);
          return;
        }
        this.preparingId = entry.chapter.id;
        const cache = this.cache(entry);
        const edgePage =
          direction === 1 ? 0 : Math.floor(Math.max(0, entry.chapter.paragraphCount - 1) / PARAGRAPHS_PER_PAGE);
        if (retry && cache.isPageFailed(edgePage))
          await cache.retryPage(entry.chapter.id, edgePage, this.loader(entry));
        await this.cache(entry).loadIndexes(
          entry.chapter.id,
          [direction === 1 ? 0 : Math.max(0, entry.chapter.paragraphCount - 1)],
          this.loader(entry),
        );
        if (!this.alive) return;
        const edge =
          direction === 1 ? 0 : Math.floor(Math.max(0, entry.chapter.paragraphCount - 1) / PARAGRAPHS_PER_PAGE);
        if (this.cache(entry).isPageFailed(edge)) throw new Error('본문을 불러오지 못했습니다.');
        if (direction === 1) this.entries.push(entry);
        else this.entries.unshift(entry);
        this.updateRowKeys();
      })
      .catch((error) => {
        if (this.alive)
          this.errors.set(direction, error instanceof Error ? error.message : '회차를 불러오지 못했습니다.');
      })
      .finally(() => {
        this.preparingId = undefined;
        this.pending.delete(direction);
        if (this.alive) this.changed();
      });
    this.pending.set(direction, operation);
    this.changed();
    return operation;
  }
  reset(): void {
    for (const cache of this.caches.values()) cache.reset();
  }
  dispose(): void {
    this.alive = false;
    this.controller.abort();
    for (const cache of this.caches.values()) cache.dispose();
    this.caches.clear();
    this.projected.clear();
  }
  private changed(): void {
    if (this.alive) {
      this.revision++;
      this.publish();
    }
  }
}
