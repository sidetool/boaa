import { isUiJson, uiKeys, uiRecord, type UiJson } from '@boaa/extension-contracts/ui-json';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../../domain/types';
import {
  bookmarkRevision,
  highlightRevision,
  noteRevision,
  ResourceRevisionConflictError,
} from '../../domain/resource-revisions';
import { AnnotationPageTooLargeError } from '../../repositories/reader-repository';
import type { PluginReaderAdapter } from './reader-session';
import { requireStore, UiStoreError } from '../ui/store-model';

type Kind = 'bookmark' | 'highlight' | 'note';
type Entity = Bookmark | ReaderHighlight | ReaderNote;
const revisions = { bookmark: bookmarkRevision, highlight: highlightRevision, note: noteRevision };
const json = (value: unknown): UiJson => {
  const result: unknown = JSON.parse(JSON.stringify(value));
  requireStore(isUiJson(result, 64 * 1024), 'ANNOTATION_LIMIT');
  return result;
};
/** Capabilities reference a snapshot, never an arbitrary caller-supplied entity ID. */
export class ReaderAnnotations {
  private handles = new Map<string, { owner: string; kind: Kind; entity: Entity; revision: string }>();
  private cursors = new Map<string, { owner: string; kind: Kind; after: string }>();
  private busy = false;
  private writes: number[] = [];
  private pending?: { owner: string; revoked: boolean };
  constructor(private adapter: PluginReaderAdapter) {}
  revoke(owner?: string) {
    if (this.pending && (!owner || this.pending.owner === owner)) this.pending.revoked = true;
    for (const [key, value] of this.cursors) if (!owner || value.owner === owner) this.cursors.delete(key);
    for (const [key, value] of this.handles) if (!owner || value.owner === owner) this.handles.delete(key);
  }
  async call(
    owner: string,
    method: string,
    input: UiJson,
    guard: () => Promise<void>,
    creationScope: string | undefined,
    signal: AbortSignal,
  ): Promise<UiJson> {
    requireStore(!this.busy, 'ANNOTATION_BUSY');
    this.busy = true;
    const pending = { owner, revoked: false };
    this.pending = pending;
    try {
      return await this.run(
        owner,
        method,
        input,
        async () => {
          requireStore(!pending.revoked, 'READER_CONTEXT_STALE');
          await guard();
          requireStore(!pending.revoked, 'READER_CONTEXT_STALE');
        },
        creationScope,
        () => requireStore(!pending.revoked && !signal.aborted, 'READER_CONTEXT_STALE'),
      );
    } finally {
      this.busy = false;
      this.pending = undefined;
    }
  }
  private async run(
    owner: string,
    method: string,
    input: UiJson,
    guard: () => Promise<void>,
    creationScope: string | undefined,
    check: () => void,
  ): Promise<UiJson> {
    requireStore(uiRecord(input), 'INVALID_ARGUMENT');
    const { repository: r, bookId, contentRevision } = this.adapter;
    await guard();
    if (method === 'reader.annotations.list') {
      requireStore(
        uiKeys(input, ['kind', ...(input.cursor === undefined ? [] : ['cursor'])]) &&
          ['bookmark', 'highlight', 'note'].includes(String(input.kind)),
        'INVALID_ARGUMENT',
      );
      const kind = input.kind as Kind;
      const cursor = typeof input.cursor === 'string' ? this.cursors.get(input.cursor) : undefined;
      requireStore(
        input.cursor === undefined || (cursor?.owner === owner && cursor.kind === kind),
        'ANNOTATION_HANDLE_INVALID',
      );
      requireStore(r.listAnnotationPage, 'ANNOTATION_BACKEND_UNSUPPORTED');
      if (input.cursor !== undefined) this.cursors.delete(input.cursor as string);
      const page = await r.listAnnotationPage(bookId, kind, cursor?.after).catch((error) => {
        if (error instanceof AnnotationPageTooLargeError) throw new UiStoreError('ANNOTATION_LIMIT');
        throw error;
      });
      await guard();
      check();
      const rows = page.entries;
      requireStore(rows.length <= 16 && rows.every((row) => row.novelId === bookId), 'ANNOTATION_LIMIT');
      requireStore(
        page.nextAfter === null ||
          (rows.length > 0 && page.nextAfter === rows.at(-1)!.id && page.nextAfter !== cursor?.after),
        'ANNOTATION_LIMIT',
      );
      // Only the current page's handles remain usable for this owner/kind.
      const entries = rows.map((entity) => ({ handle: crypto.randomUUID(), value: entity }));
      const nextCursor = page.nextAfter === null ? null : crypto.randomUUID();
      const result = json({ entries, nextCursor });
      const otherCursors = [...this.cursors.values()].filter(
        (value) => value.owner !== owner || value.kind !== kind,
      ).length;
      const otherHandles = [...this.handles.values()].filter(
        (value) => value.owner !== owner || value.kind !== kind,
      ).length;
      requireStore(otherCursors < 128 || nextCursor === null, 'ANNOTATION_LIMIT');
      requireStore(otherHandles + entries.length <= 512, 'ANNOTATION_LIMIT');
      for (const [key, value] of this.cursors)
        if (value.owner === owner && value.kind === kind) this.cursors.delete(key);
      if (nextCursor) this.cursors.set(nextCursor, { owner, kind, after: page.nextAfter! });
      for (const [key, entry] of this.handles)
        if (entry.owner === owner && entry.kind === kind) this.handles.delete(key);
      for (const entry of entries)
        this.handles.set(entry.handle, {
          owner,
          kind,
          entity: entry.value,
          revision: revisions[kind](entry.value as Bookmark & ReaderHighlight & ReaderNote),
        });
      return result;
    }
    requireStore(r.capabilities.backend === 'hosted', 'ANNOTATION_BACKEND_UNSUPPORTED');
    const creating = method === 'reader.annotations.create';
    const removing = method === 'reader.annotations.delete';
    requireStore(creating || removing || method === 'reader.annotations.update', 'METHOD_NOT_ALLOWED');
    requireStore(
      uiKeys(
        input,
        creating
          ? ['kind', 'paragraphId', 'textHash', 'fields', 'requestId']
          : removing
            ? ['handle']
            : ['handle', 'fields'],
      ),
      'INVALID_ARGUMENT',
    );
    const saved = typeof input.handle === 'string' ? this.handles.get(input.handle) : undefined;
    requireStore(creating || saved?.owner === owner, 'ANNOTATION_HANDLE_INVALID');
    const kind = creating ? (input.kind as Kind) : saved!.kind;
    requireStore(['bookmark', 'highlight', 'note'].includes(kind), 'INVALID_ARGUMENT');
    const options = {
      expectedRevision: saved?.revision ?? revisions[kind](),
      expectedContentRevision: contentRevision,
      ...(creating ? { createOnly: true } : {}),
    };
    let entity: Entity;
    if (creating) {
      requireStore(
        creationScope &&
          typeof input.requestId === 'string' &&
          input.requestId.length > 0 &&
          input.requestId.length <= 256,
        'INVALID_ARGUMENT',
      );
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([creationScope, bookId, kind, input.requestId])),
      );
      const id =
        'plugin_annotation_' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      await guard();
      requireStore(
        typeof input.paragraphId === 'string' && input.paragraphId.length <= 256 && typeof input.textHash === 'string',
        'INVALID_ARGUMENT',
      );
      const p = await r.getParagraph(input.paragraphId);
      await guard();
      requireStore(
        p &&
          p.novelId === bookId &&
          p.textHash === input.textHash &&
          this.adapter.chapters.some((c) => c.id === p.chapterId),
        'CONTENT_CHANGED',
      );
      const chapter = this.adapter.chapters.find((c) => c.id === p.chapterId)!;
      const progress =
        chapter.paragraphCount > 1 ? Math.min(1, Math.max(0, p.index / (chapter.paragraphCount - 1))) : 0;
      const now = new Date().toISOString();
      entity = {
        id,
        novelId: bookId,
        chapterId: p.chapterId,
        paragraphId: p.id,
        progress,
        createdAt: now,
        ...(kind === 'bookmark'
          ? { label: '', scrollTop: 0 }
          : kind === 'highlight'
            ? { quote: '', color: 'yellow' as const, updatedAt: now }
            : { body: '', updatedAt: now }),
      };
      if (kind === 'highlight') {
        requireStore(
          uiRecord(input.fields) &&
            typeof input.fields.quote === 'string' &&
            input.fields.quote.length > 0 &&
            p.text.includes(input.fields.quote),
          'INVALID_ARGUMENT',
        );
      }
    } else entity = { ...saved!.entity };
    if (!removing) {
      const fields = input.fields;
      const allowed =
        kind === 'bookmark' ? ['label'] : kind === 'highlight' ? (creating ? ['color', 'quote'] : ['color']) : ['body'];
      requireStore(uiRecord(fields) && uiKeys(fields, allowed), 'INVALID_ARGUMENT');
      for (const key of allowed)
        requireStore(
          typeof fields[key] === 'string' &&
            (fields[key] as string).trim().length > 0 &&
            (fields[key] as string).length <= (key === 'body' ? 16000 : key === 'quote' ? 8000 : 256),
          'INVALID_ARGUMENT',
        );
      if (kind === 'highlight')
        requireStore(['yellow', 'green', 'blue', 'pink'].includes(String(fields.color)), 'INVALID_ARGUMENT');
      entity = { ...entity, ...fields } as Entity;
      if (kind !== 'bookmark') (entity as ReaderNote).updatedAt = new Date().toISOString();
    }
    this.writes = this.writes.filter((time) => time > Date.now() - 60000);
    requireStore(this.writes.length < 30, 'ANNOTATION_RATE_LIMIT');
    await guard(); // Last check before dispatch. An already dispatched write cannot be undone by cancellation.
    check(); // No await between the final lifetime check and repository dispatch.
    this.writes.push(Date.now());
    if (!creating) this.handles.delete(input.handle as string); // Single use even on ambiguous transport failure.
    try {
      if (removing) {
        if (kind === 'bookmark') await r.deleteBookmark(entity.id, options);
        else if (kind === 'highlight') await r.deleteHighlight(entity.id, options);
        else await r.deleteNote(entity.id, options);
      } else {
        if (kind === 'bookmark') await r.saveBookmark(entity as Bookmark, options);
        else if (kind === 'highlight') await r.saveHighlight(entity as ReaderHighlight, options);
        else await r.saveNote(entity as ReaderNote, options);
      }
    } catch (error) {
      throw new UiStoreError(
        error instanceof ResourceRevisionConflictError ? 'ANNOTATION_CONFLICT' : 'ANNOTATION_OUTCOME_UNKNOWN',
      );
    }
    this.adapter.annotationsChanged?.();
    await guard();
    return { id: entity.id }; // Re-list before another update; server normalization may change the revision.
  }
}
