import type { Chapter, Novel } from '../domain/types';
/** Appending TXT episodes does not replace the currently playing immutable chapter. */
export class TTSContentIdentity {
  private previous?: {
    book?: string;
    chapter?: string;
    hash?: string;
    count?: number;
    revision?: string;
    format?: string;
  };
  private identity: object = {};
  update(book?: Novel, chapter?: Chapter): object {
    const next = {
      book: book?.id,
      chapter: chapter?.id,
      hash: chapter?.textHash,
      count: chapter?.paragraphCount,
      revision: book?.activeContentRevisionId,
      format: book?.format,
    };
    const previous = this.previous;
    const changed =
      !previous ||
      previous.book !== next.book ||
      previous.format !== next.format ||
      (next.format === 'txt' && next.hash
        ? previous.chapter === next.chapter && (previous.hash !== next.hash || previous.count !== next.count)
        : previous.revision !== next.revision);
    if (changed) this.identity = {};
    this.previous = next;
    return this.identity;
  }
}
