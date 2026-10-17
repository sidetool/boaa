import { ReaderAnnotations } from './reader-annotations';
import { isUiJson, uiInteger, uiKeys, uiRecord, type UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore } from '../ui/store-model';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { Chapter } from '../../domain/types';
export interface ReaderMotion {
  update(speed: number): void;
  stop(): void;
  active(): boolean;
}
/** Body reads and annotation mutations used by the hosted plugin reader session. */
export type PluginReaderRepository = Pick<
  ReaderRepository,
  | 'capabilities'
  | 'getNovel'
  | 'getParagraph'
  | 'getParagraphPage'
  | 'listAnnotationPage'
  | 'saveBookmark'
  | 'deleteBookmark'
  | 'saveHighlight'
  | 'deleteHighlight'
  | 'saveNote'
  | 'deleteNote'
>;

export interface PluginReaderAdapter {
  bookId: string;
  chapterId: string;
  contentRevision: string;
  chapters: readonly Chapter[];
  repository: PluginReaderRepository;
  annotationsChanged?(): void;
  state(): UiJson;
  start(speed: number): ReaderMotion | undefined;
}
interface Cursor {
  chapter: number;
  page: number;
  offset: number;
}
/** One actual Reader generation. No guest-provided book ID, DOM node, or userGesture boolean is authority. */
export class PluginReaderSession {
  private closed = false;
  private epochs = new Map<string, number>();
  private reading = new Set<string>();
  private cursors = new Map<string, { owner: string; query?: string; position: Cursor }>();
  private interactions = new Map<string, { owner: string; signal: AbortSignal; dispose(): void }>();
  private motion?: { id: string; interaction: string; owner: string; handle: ReaderMotion };
  private annotations: ReaderAnnotations;
  constructor(readonly adapter: PluginReaderAdapter) {
    this.annotations = new ReaderAnnotations(adapter);
  }
  private guard(signal?: AbortSignal) {
    requireStore(!this.closed && !signal?.aborted, 'READER_CONTEXT_STALE');
  }
  begin(owner: string, signal: AbortSignal): string {
    this.guard(signal);
    requireStore(this.interactions.size < 4, 'INPUT_LIMIT');
    const id = crypto.randomUUID();
    const dispose = () => {
      signal.removeEventListener('abort', dispose);
      if (this.motion?.interaction === id) this.stopMotion();
      this.interactions.delete(id);
    };
    this.interactions.set(id, { owner, signal, dispose });
    signal.addEventListener('abort', dispose, { once: true });
    return id;
  }
  private stopMotion() {
    const motion = this.motion;
    this.motion = undefined;
    motion?.handle.stop();
  }
  revoke(owner: string) {
    this.annotations.revoke(owner);
    if (this.reading.has(owner)) this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [id, cursor] of this.cursors) if (cursor.owner === owner) this.cursors.delete(id);
    for (const entry of [...this.interactions.values()]) if (entry.owner === owner) entry.dispose();
  }
  end(interactionId: string) {
    this.interactions.get(interactionId)?.dispose();
  }
  interrupt() {
    for (const entry of [...this.interactions.values()]) entry.dispose();
    this.stopMotion();
  }
  async call(
    owner: string,
    method: string,
    input: UiJson,
    signal: AbortSignal,
    authorize?: () => Promise<void>,
    creationScope?: string,
  ): Promise<UiJson> {
    this.guard(signal);
    requireStore(uiRecord(input), 'INVALID_ARGUMENT');
    if (method.startsWith('reader.annotations.')) {
      return this.annotations.call(
        owner,
        method,
        input,
        async () => {
          this.guard(signal);
          await authorize?.();
          this.guard(signal);
          const book = await this.adapter.repository.getNovel(this.adapter.bookId);
          this.guard(signal);
          requireStore(
            book?.activeContentRevisionId === this.adapter.contentRevision && !book.deletedAt,
            'CONTENT_CHANGED',
          );
        },
        creationScope,
        signal,
      );
    }
    if (method === 'reader.state.get') {
      requireStore(uiKeys(input, []), 'INVALID_ARGUMENT');
      return this.adapter.state();
    }
    if (method === 'reader.content.read' || method === 'reader.content.search') {
      requireStore(uiKeys(input, method.endsWith('search') ? ['query'] : [], ['cursor']), 'INVALID_ARGUMENT');
      if (method.endsWith('search'))
        requireStore(
          typeof input.query === 'string' && input.query.length > 0 && input.query.length <= 256,
          'INVALID_ARGUMENT',
        );
      requireStore(!this.reading.has(owner), 'CONTENT_BUSY');
      this.reading.add(owner);
      try {
        return await this.read(owner, input.cursor, typeof input.query === 'string' ? input.query : undefined, signal);
      } finally {
        this.reading.delete(owner);
        this.epochs.delete(owner);
      }
    }
    if (method === 'reader.auto.start') {
      requireStore(
        uiKeys(input, ['interactionId', 'speed']) &&
          typeof input.interactionId === 'string' &&
          uiInteger(input.speed, 1, 12),
        'INVALID_ARGUMENT',
      );
      const interaction = this.interactions.get(input.interactionId);
      requireStore(interaction?.owner === owner && !interaction.signal.aborted, 'INPUT_EXPIRED');
      requireStore(!this.motion || this.motion.interaction === input.interactionId, 'READER_BUSY');
      if (this.motion) {
        requireStore(this.motion.handle.active(), 'INPUT_EXPIRED');
        this.motion.handle.update(input.speed);
        return { leaseId: this.motion.id };
      }
      const handle = this.adapter.start(input.speed);
      requireStore(handle, 'READER_UNAVAILABLE');
      this.motion = { id: crypto.randomUUID(), owner, interaction: input.interactionId, handle };
      return { leaseId: this.motion.id };
    }
    requireStore(method === 'reader.auto.update' || method === 'reader.auto.stop', 'METHOD_NOT_ALLOWED');
    requireStore(
      uiKeys(input, method.endsWith('update') ? ['leaseId', 'speed'] : ['leaseId']) &&
        typeof input.leaseId === 'string',
      'INVALID_ARGUMENT',
    );
    if (method.endsWith('update')) requireStore(uiInteger(input.speed, 1, 12), 'INVALID_ARGUMENT');
    const motion = this.motion;
    if (!motion || motion.id !== input.leaseId || motion.owner !== owner) {
      requireStore(method.endsWith('stop'), 'INPUT_EXPIRED');
      return null; // A stale stop never affects the newer owner.
    }
    if (method.endsWith('stop')) this.stopMotion();
    else {
      requireStore(motion.handle.active() && this.interactions.has(motion.interaction), 'INPUT_EXPIRED');
      motion.handle.update(input.speed as number);
    }
    return null;
  }
  private async read(
    owner: string,
    token: UiJson | undefined,
    query: string | undefined,
    signal: AbortSignal,
  ): Promise<UiJson> {
    requireStore(token === undefined || typeof token === 'string', 'INVALID_CURSOR');
    const saved = typeof token === 'string' ? this.cursors.get(token) : undefined;
    requireStore(token === undefined || (saved?.owner === owner && saved.query === query), 'INVALID_CURSOR');
    const position = token === undefined ? { chapter: 0, page: 0, offset: 0 } : saved?.position;
    requireStore(position, 'INVALID_CURSOR');
    const next = { ...position };
    const epoch = this.epochs.get(owner);
    const guard = () => {
      this.guard(signal);
      requireStore(this.epochs.get(owner) === epoch, 'READER_CONTEXT_STALE');
    };
    const { repository, bookId, contentRevision, chapters } = this.adapter;
    const revision = async () => {
      const book = await repository.getNovel(bookId);
      guard();
      requireStore(book?.activeContentRevisionId === contentRevision && !book.deletedAt, 'CONTENT_CHANGED');
    };
    await revision();
    const blocks: UiJson[] = [];
    let scanned = 0,
      pages = 0;
    while (next.chapter < chapters.length && scanned < 32 && pages < 4) {
      const chapter = chapters[next.chapter];
      requireStore(chapter.novelId === bookId, 'CONTENT_CHANGED');
      const page = await repository.getParagraphPage(chapter.id, next.page, signal);
      guard();
      pages++;
      if (!page || next.offset >= page.paragraphs.length) {
        next.chapter++;
        next.page = 0;
        next.offset = 0;
        continue;
      }
      requireStore(
        page.novelId === bookId && page.chapterId === chapter.id && page.pageIndex === next.page,
        'CONTENT_CHANGED',
      );
      while (next.offset < page.paragraphs.length && scanned < 32) {
        const paragraph = page.paragraphs[next.offset];
        requireStore(paragraph.novelId === bookId && paragraph.chapterId === chapter.id, 'CONTENT_CHANGED');
        const block = {
          id: paragraph.id,
          chapterId: chapter.id,
          index: paragraph.index,
          text: paragraph.text,
          textHash: paragraph.textHash,
        };
        if (!query || paragraph.text.includes(query)) {
          if (!isUiJson([...blocks, block], 48 * 1024)) {
            requireStore(blocks.length > 0, 'CONTENT_LIMIT');
            scanned = 32;
            break;
          }
          blocks.push(block);
        }
        scanned++;
        next.offset++;
      }
      if (next.offset >= page.paragraphs.length) {
        next.page++;
        next.offset = 0;
      }
    }
    await revision();
    let cursor: string | null = null;
    if (next.chapter < chapters.length) {
      requireStore(this.cursors.size < 128 || typeof token === 'string', 'CURSOR_LIMIT');
      cursor = crypto.randomUUID();
      this.cursors.set(cursor, { owner, query, position: next });
    }
    if (typeof token === 'string') this.cursors.delete(token);
    return { bookId, contentRevision, blocks, cursor };
  }
  close() {
    this.closed = true;
    this.annotations.revoke();
    this.interrupt();
    this.cursors.clear();
  }
}
