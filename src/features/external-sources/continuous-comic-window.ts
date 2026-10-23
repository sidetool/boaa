import type { Chapter } from '../../domain/types';
import type { SourceStreamBuffer } from '../../external-sources/source-stream-buffer';
import type { SourceStreamSession } from '../../external-sources/source-stream';
import type { SourceStreamEpisode } from './SourceStreamReader';
import { sourceStreamDocument } from './source-stream-document';
import { stableId } from '../../domain/hash';

type Projection = ReturnType<typeof sourceStreamDocument>;
interface Entry {
  episode: SourceStreamEpisode;
  projection: Projection;
  count: number;
}

/** Owns stable page identities while only keeping the visible episode and its neighbors open. */
export class ContinuousComicWindow {
  readonly entries: Entry[] = [];
  readonly controller = new AbortController();
  readonly repository: Projection['repository'];
  readonly assets: Projection['assets'];
  readonly novel: Projection['novel'];
  chapters: readonly Chapter[] = [];
  readonly initialChapterIds: readonly string[];
  private routes = new Map<string, Entry>();
  private pending?: Promise<Entry | undefined>;
  private errors = new Set<-1 | 1>();
  private ends = new Set<-1 | 1>();
  private pendingDirection?: -1 | 1;
  private active?: Entry;
  private readonly loaded = new Set<string>();
  private readonly visited = new Set<string>();
  private leases = 0;
  constructor(
    initial: SourceStreamEpisode,
    session: SourceStreamSession,
    private readonly buffer: SourceStreamBuffer,
    private readonly neighbor: NonNullable<SourceStreamEpisodeNeighbor>,
    private readonly changed: () => void,
    private readonly observed: (episode: SourceStreamEpisode) => void,
    workTitle?: string,
  ) {
    const entry = this.create(initial, session.pageCount, workTitle);
    this.novel = entry.projection.novel;
    this.initialChapterIds = entry.projection.chapters.map((chapter) => chapter.id);
    this.entries.push(entry);
    this.active = entry;
    this.rebuild();
    this.repository = {
      getParagraphPage: (id, page, signal) =>
        this.routes.get(id)?.projection.repository.getParagraphPage(id, page, signal) ?? Promise.resolve(undefined),
    };
    this.assets = {
      openSource: async () => undefined,
      getEmbeddedResource: (bookId, assetId, signal) =>
        this.routes.get(assetId)?.projection.assets.getEmbeddedResource(bookId, assetId, signal) ??
        Promise.resolve(undefined),
    };
  }
  acquire(): () => void {
    this.leases++;
    return () => {
      this.leases--;
      queueMicrotask(() => {
        if (!this.leases) this.controller.abort();
      });
    };
  }
  private create(episode: SourceStreamEpisode, count: number, workTitle?: string): Entry {
    const projection = sourceStreamDocument(
      stableId('source_stream', episode.historyKey),
      episode.title,
      {
        pageCount: count,
        loadPage: async (index, signal) => {
          const joined = AbortSignal.any([signal, this.controller.signal]);
          const session = await this.buffer.open(episode.remoteId, joined);
          if (session.pageCount !== count) throw new Error('회차 구성이 변경됐습니다. 목록에서 다시 열어 주세요.');
          return session.loadPage(index, joined);
        },
        close: () => undefined,
      },
      () => {
        this.loaded.add(episode.remoteId);
      },
      workTitle,
    );
    return { episode, projection, count };
  }
  private rebuild(): void {
    const chapters: Chapter[] = [];
    this.routes.clear();
    for (const [sectionIndex, entry] of this.entries.entries()) {
      for (const chapter of entry.projection.chapters) {
        this.routes.set(chapter.id, entry);
        chapters.push({
          ...chapter,
          novelId: this.novel.id,
          index: chapters.length + 1,
          documentSectionIndex: sectionIndex,
        });
      }
    }
    this.chapters = chapters;
  }
  locate(index: number): { entry: Entry; page: number } | undefined {
    const chapter = this.chapters[index];
    const entry = chapter && this.routes.get(chapter.id);
    return entry ? { entry, page: chapter.documentPageIndexInSection ?? 0 } : undefined;
  }
  locateId(id: string): { entry: Entry; page: number } | undefined {
    const entry = this.routes.get(id);
    const page = entry?.projection.chapters.findIndex((chapter) => chapter.id === id);
    return entry && page !== undefined && page >= 0 ? { entry, page } : undefined;
  }
  status(direction: -1 | 1): 'ready' | 'loading' | 'error' | 'end' {
    return this.errors.has(direction)
      ? 'error'
      : this.ends.has(direction)
        ? 'end'
        : this.pendingDirection === direction
          ? 'loading'
          : 'ready';
  }
  observe(index: number): void {
    const location = this.locate(index);
    if (!location) return;
    if (this.active !== location.entry) {
      this.active = location.entry;
    }
    if (this.loaded.has(location.entry.episode.remoteId) && !this.visited.has(location.entry.episode.remoteId)) {
      this.visited.add(location.entry.episode.remoteId);
      this.observed(location.entry.episode);
    }
    if (!this.pending) {
      const at = this.entries.indexOf(location.entry);
      this.buffer.retain(this.entries.slice(Math.max(0, at - 1), at + 2).map((entry) => entry.episode.remoteId));
      if (this.entries.length > 5) {
        const start = Math.max(0, at - 2);
        const end = Math.min(this.entries.length, at + 3);
        if (end < this.entries.length) {
          this.entries.splice(end);
          this.ends.delete(1);
          this.errors.delete(1);
        }
        if (start > 0) {
          this.entries.splice(0, start);
          this.ends.delete(-1);
          this.errors.delete(-1);
        }
        this.rebuild();
        this.changed();
      }
    }
  }
  canNavigate(direction: -1 | 1): boolean {
    const at = this.active ? this.entries.indexOf(this.active) : -1;
    return Boolean(this.entries[at + direction]) || !this.ends.has(direction);
  }
  async adjacent(direction: -1 | 1): Promise<Entry | undefined> {
    if (this.controller.signal.aborted) return undefined;
    // Explicit navigation is relative to the visible episode. Preparation is
    // relative to the retained window edge; those origins differ after a visit.
    const at = this.active ? this.entries.indexOf(this.active) : -1;
    const known = at >= 0 ? this.entries[at + direction] : undefined;
    if (known) return known;
    // Opposite-edge prefetch must not swallow an explicit navigation request.
    if (this.pending) {
      await this.pending;
      return this.adjacent(direction);
    }
    return this.prepare(direction, true);
  }
  async prepare(direction: -1 | 1, retry = false): Promise<Entry | undefined> {
    if (this.controller.signal.aborted || this.ends.has(direction) || (!retry && this.errors.has(direction))) return;
    if (this.pending) return this.pendingDirection === direction ? this.pending : undefined;
    const origin = direction === 1 ? this.entries.at(-1)! : this.entries[0];
    this.errors.delete(direction);
    this.pendingDirection = direction;
    this.pending = Promise.resolve()
      .then(async () => {
        const episode = await this.neighbor(origin.episode.remoteId, direction, this.controller.signal);
        this.controller.signal.throwIfAborted();
        if (!episode || this.entries.some((entry) => entry.episode.remoteId === episode.remoteId)) {
          this.ends.add(direction);
          return;
        }
        const session = await this.buffer.open(episode.remoteId, this.controller.signal);
        if (session.pageCount < 1) throw new Error('회차에 이미지가 없습니다.');
        // The visible page loader owns decoding; opening an episode only prepares its metadata.
        const entry = this.create(episode, session.pageCount, this.novel.title);
        this.controller.signal.throwIfAborted();
        if (direction === 1) this.entries.push(entry);
        else this.entries.unshift(entry);
        this.rebuild();
        return entry;
      })
      .catch(() => {
        if (!this.controller.signal.aborted) this.errors.add(direction);
        return undefined;
      })
      .finally(() => {
        this.pending = undefined;
        this.pendingDirection = undefined;
        if (!this.controller.signal.aborted) this.changed();
      });
    this.changed();
    return this.pending;
  }
  invalidate(index: number): void {
    const found = this.locate(index);
    if (found)
      void this.buffer
        .open(found.entry.episode.remoteId, this.controller.signal)
        .then((session) => session.invalidatePage?.(found.page))
        .catch(() => undefined);
  }
}
type SourceStreamEpisodeNeighbor = (
  remoteId: string,
  direction: -1 | 1,
  signal: AbortSignal,
) => Promise<SourceStreamEpisode | undefined>;
