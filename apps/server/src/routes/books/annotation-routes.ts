import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { resourceEntityRevision } from '@boaa/text-core/identity/sync';
import type { ServerConfig } from '../../config.js';
import { hasBookChapterAccess } from './book-access-query.js';
import { mapBookmarkRows, mapHighlightRows, mapNoteRows } from './row-mappers.js';
import { validateBookmarkBody, validateHighlightBody, validateNoteBody } from './request-contracts.js';
import { createServerRevision } from './sync-event-repository.js';
import { insertServerSyncEvent, withTransaction, type QueryRunner } from '../ai/sync-event-repository.js';
import {
  assertServerResourceRevision,
  expectedResourceRevision,
  lockBookResource,
  ServerResourceRevisionConflictError,
} from '../resource-revision.js';

async function assertAnnotationContent(
  db: QueryRunner,
  userId: string,
  bookId: string,
  body: Record<string, unknown> | undefined,
) {
  if (body?.expectedContentRevision === undefined) return;
  const result = await db.query(
    'select active_content_revision_id from library_books where id = $1 and user_id = $2 and deleted_at is null',
    [bookId, userId],
  );
  assertServerResourceRevision(
    'book_content',
    String(body.expectedContentRevision),
    String(result.rows[0]?.active_content_revision_id ?? ''),
  );
}

async function assertAnnotationCreate(
  db: QueryRunner,
  kind: 'bookmarks' | 'highlights' | 'notes',
  id: string,
  body: Record<string, unknown>,
) {
  if (body.createOnly !== true) return;
  const result = await db.query(`select id from ${kind} where id = $1`, [id]);
  if (result.rows.length) throw new ServerResourceRevisionConflictError(kind, 'absent', 'exists');
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function currentBookmarkValue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: String(row.chapter_id),
    paragraphId: optionalString(row.paragraph_id),
    label: String(row.label),
    progress: Number(row.progress),
    scrollTop: Number(row.scroll_top),
    createdAt: isoTimestamp(row.created_at),
  };
}

function currentHighlightValue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: String(row.chapter_id),
    paragraphId: String(row.paragraph_id),
    quote: String(row.quote),
    color: String(row.color),
    progress: Number(row.progress),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function currentNoteValue(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: String(row.chapter_id),
    paragraphId: optionalString(row.paragraph_id),
    quote: optionalString(row.quote),
    body: String(row.body),
    progress: Number(row.progress),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

async function currentBookmarkRevision(db: QueryRunner, userId: string, id: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, chapter_id, paragraph_id, label, progress, scroll_top, created_at
     from bookmarks where id = $1 and user_id = $2 and deleted_at is null`,
    [id, userId],
  );
  return resourceEntityRevision('bookmark', result.rows[0] ? currentBookmarkValue(result.rows[0]) : undefined);
}

async function currentHighlightRevision(db: QueryRunner, userId: string, id: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, chapter_id, paragraph_id, quote, color, progress, created_at, updated_at
     from highlights where id = $1 and user_id = $2 and deleted_at is null`,
    [id, userId],
  );
  return resourceEntityRevision('highlight', result.rows[0] ? currentHighlightValue(result.rows[0]) : undefined);
}

async function currentNoteRevision(db: QueryRunner, userId: string, id: string): Promise<string> {
  const result = await db.query(
    `select id, book_id, chapter_id, paragraph_id, quote, body, progress, created_at, updated_at
     from notes where id = $1 and user_id = $2 and deleted_at is null`,
    [id, userId],
  );
  return resourceEntityRevision('note', result.rows[0] ? currentNoteValue(result.rows[0]) : undefined);
}

function resourceConflictPayload(error: ServerResourceRevisionConflictError) {
  return {
    error: 'resource revision conflict',
    resourceKind: error.resourceKind,
    expectedRevision: error.expectedRevision,
    actualRevision: error.actualRevision,
  };
}

export async function registerAnnotationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  // Additive paging path: existing UI list endpoints retain their ordering/shape.
  app.get<{ Params: { bookId: string; kind: string }; Querystring: { after?: string } }>(
    '/api/books/:bookId/annotations/:kind',
    async (request, reply) => {
      const kinds = {
        bookmark: { table: 'bookmarks', columns: 'label, scroll_top' },
        highlight: { table: 'highlights', columns: 'quote, color, updated_at' },
        note: { table: 'notes', columns: 'quote, body, updated_at' },
      };
      if (!Object.hasOwn(kinds, request.params.kind)) return reply.code(400).send({ error: 'invalid annotation kind' });
      const after = request.query.after;
      if (after !== undefined && (typeof after !== 'string' || !after.length || after.length > 512))
        return reply.code(400).send({ error: 'invalid annotation cursor' });
      const { table, columns } = kinds[request.params.kind as keyof typeof kinds];
      const result = await pool.query(
        `select id, book_id, chapter_id, paragraph_id, progress, created_at, ${columns}
         from ${table} where book_id = $1 and user_id = $2 and deleted_at is null
         and ($3::text is null or id > $3) order by id asc limit 17`,
        [request.params.bookId, config.defaultUserId, after ?? null],
      );
      const entries: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const row of result.rows.slice(0, 16)) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (bytes + size > 56 * 1024) break;
        entries.push(row);
        bytes += size;
      }
      // Never truncate annotation text or silently skip an oversized entity.
      if (result.rows.length && !entries.length) return reply.code(413).send({ error: 'annotation too large' });
      return { entries, nextAfter: result.rows.length > entries.length ? String(entries.at(-1)!.id) : null };
    },
  );

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/bookmarks', async (request) => {
    const result = await pool.query(
      'select id, book_id, chapter_id, paragraph_id, label, progress, scroll_top, created_at from bookmarks where book_id = $1 and user_id = $2 and deleted_at is null order by created_at desc',
      [request.params.bookId, config.defaultUserId],
    );
    return { bookmarks: mapBookmarkRows(result.rows) };
  });

  app.post<{ Params: { bookId: string }; Body: Record<string, unknown> }>(
    '/api/books/:bookId/bookmarks',
    async (request, reply) => {
      const parsed = validateBookmarkBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const expectedRevision = expectedResourceRevision(request.body);
      const bookmark = {
        ...parsed.value,
        novelId: request.params.bookId,
        bookId: request.params.bookId,
      };
      if (!(await hasBookChapterAccess(pool, config, request.params.bookId, bookmark.chapterId))) {
        return reply.code(404).send({ error: 'book or chapter not found' });
      }
      const createdAt = bookmark.createdAt;
      const updatedAt = expectedRevision ? new Date().toISOString() : createdAt;
      try {
        const applied = await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (!(await hasBookChapterAccess(db, config, request.params.bookId, bookmark.chapterId))) {
            throw new Error('book or chapter not found');
          }
          await assertAnnotationContent(db, config.defaultUserId, request.params.bookId, request.body);
          await assertAnnotationCreate(db, 'bookmarks', bookmark.id, request.body);
          if (expectedRevision) {
            assertServerResourceRevision(
              'bookmark',
              expectedRevision,
              await currentBookmarkRevision(db, config.defaultUserId, bookmark.id),
            );
          }
          const saved = await db.query(
            `
          insert into bookmarks (id, book_id, user_id, chapter_id, paragraph_id, label, progress, scroll_top, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          on conflict (id) do update
            set label = excluded.label,
                progress = excluded.progress,
                scroll_top = excluded.scroll_top,
                updated_at = excluded.updated_at,
                deleted_at = null
            where bookmarks.book_id = excluded.book_id
              and bookmarks.user_id = excluded.user_id
              and bookmarks.updated_at <= excluded.updated_at
          returning id
            `,
            [
              bookmark.id,
              request.params.bookId,
              config.defaultUserId,
              bookmark.chapterId,
              bookmark.paragraphId,
              bookmark.label,
              bookmark.progress ?? 0,
              bookmark.scrollTop ?? 0,
              createdAt,
              updatedAt,
            ],
          );
          if ((saved.rowCount ?? 0) === 0) return false;
          const payload = { bookmark };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `bookmark_created:${bookmark.id}:${updatedAt}${expectedRevision ? `:${expectedRevision}` : ''}`,
            type: 'bookmark_created',
            bookId: request.params.bookId,
            entityId: bookmark.id,
            payload,
            revision: createServerRevision({
              entityType: 'bookmark',
              entityId: bookmark.id,
              novelId: request.params.bookId,
              updatedAt,
              payload,
            }),
            createdAt: updatedAt,
          });
          return true;
        });
        if (!applied) return { ok: true, applied: false };
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && ['book not found', 'book or chapter not found'].includes(error.message)) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true, applied: true };
    },
  );

  app.delete<{ Params: { bookmarkId: string }; Body: Record<string, unknown> }>(
    '/api/bookmarks/:bookmarkId',
    async (request, reply) => {
      const expectedRevision = expectedResourceRevision(request.body);
      const deletedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          const owner = await db.query('select book_id from bookmarks where id = $1 and user_id = $2', [
            request.params.bookmarkId,
            config.defaultUserId,
          ]);
          const bookId = owner.rows[0]?.book_id as string | undefined;
          if (!bookId || !(await lockBookResource(db, config.defaultUserId, bookId)))
            throw new Error('bookmark not found');
          await assertAnnotationContent(db, config.defaultUserId, bookId, request.body);
          if (expectedRevision) {
            assertServerResourceRevision(
              'bookmark',
              expectedRevision,
              await currentBookmarkRevision(db, config.defaultUserId, request.params.bookmarkId),
            );
          }
          const deleted = await db.query(
            'update bookmarks set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and deleted_at is null returning book_id',
            [request.params.bookmarkId, config.defaultUserId, deletedAt],
          );
          if (!deleted.rows[0]) throw new Error('bookmark not found');
          const payload = { id: request.params.bookmarkId, deletedAt };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `bookmark_deleted:${request.params.bookmarkId}:${deletedAt}`,
            type: 'bookmark_deleted',
            bookId,
            entityId: request.params.bookmarkId,
            payload,
            revision: createServerRevision({
              entityType: 'bookmark',
              entityId: request.params.bookmarkId,
              novelId: bookId,
              deletedAt,
              payload,
            }),
            createdAt: deletedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && error.message === 'bookmark not found') {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/highlights', async (request) => {
    const result = await pool.query(
      'select id, book_id, chapter_id, paragraph_id, quote, color, progress, created_at, updated_at from highlights where book_id = $1 and user_id = $2 and deleted_at is null order by updated_at desc',
      [request.params.bookId, config.defaultUserId],
    );
    return { highlights: mapHighlightRows(result.rows) };
  });

  app.post<{ Params: { bookId: string }; Body: Record<string, unknown> }>(
    '/api/books/:bookId/highlights',
    async (request, reply) => {
      const parsed = validateHighlightBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const expectedRevision = expectedResourceRevision(request.body);
      const highlight = {
        ...parsed.value,
        novelId: request.params.bookId,
        bookId: request.params.bookId,
      };
      if (!(await hasBookChapterAccess(pool, config, request.params.bookId, highlight.chapterId))) {
        return reply.code(404).send({ error: 'book or chapter not found' });
      }
      try {
        const applied = await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (!(await hasBookChapterAccess(db, config, request.params.bookId, highlight.chapterId))) {
            throw new Error('book or chapter not found');
          }
          await assertAnnotationContent(db, config.defaultUserId, request.params.bookId, request.body);
          await assertAnnotationCreate(db, 'highlights', highlight.id, request.body);
          if (expectedRevision) {
            assertServerResourceRevision(
              'highlight',
              expectedRevision,
              await currentHighlightRevision(db, config.defaultUserId, highlight.id),
            );
          }
          const saved = await db.query(
            `
          insert into highlights (id, book_id, user_id, chapter_id, paragraph_id, quote, color, progress, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          on conflict (id) do update
            set quote = excluded.quote,
                color = excluded.color,
                progress = excluded.progress,
                updated_at = excluded.updated_at,
                deleted_at = null
            where highlights.book_id = excluded.book_id
              and highlights.user_id = excluded.user_id
              and highlights.updated_at <= excluded.updated_at
          returning id
            `,
            [
              highlight.id,
              request.params.bookId,
              config.defaultUserId,
              highlight.chapterId,
              highlight.paragraphId,
              highlight.quote,
              highlight.color,
              highlight.progress ?? 0,
              highlight.createdAt,
              highlight.updatedAt,
            ],
          );
          if ((saved.rowCount ?? 0) === 0) return false;
          const payload = { highlight };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `highlight_created:${highlight.id}:${highlight.updatedAt}`,
            type: 'highlight_created',
            bookId: request.params.bookId,
            entityId: highlight.id,
            payload,
            revision: createServerRevision({
              entityType: 'highlight',
              entityId: highlight.id,
              novelId: request.params.bookId,
              updatedAt: highlight.updatedAt,
              payload,
            }),
            createdAt: highlight.updatedAt,
          });
          return true;
        });
        if (!applied) return { ok: true, applied: false };
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && ['book not found', 'book or chapter not found'].includes(error.message)) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true, applied: true };
    },
  );

  app.delete<{ Params: { highlightId: string }; Body: Record<string, unknown> }>(
    '/api/highlights/:highlightId',
    async (request, reply) => {
      const expectedRevision = expectedResourceRevision(request.body);
      const deletedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          const owner = await db.query('select book_id from highlights where id = $1 and user_id = $2', [
            request.params.highlightId,
            config.defaultUserId,
          ]);
          const bookId = owner.rows[0]?.book_id as string | undefined;
          if (!bookId || !(await lockBookResource(db, config.defaultUserId, bookId)))
            throw new Error('highlight not found');
          await assertAnnotationContent(db, config.defaultUserId, bookId, request.body);
          if (expectedRevision) {
            assertServerResourceRevision(
              'highlight',
              expectedRevision,
              await currentHighlightRevision(db, config.defaultUserId, request.params.highlightId),
            );
          }
          const deleted = await db.query(
            'update highlights set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and deleted_at is null returning book_id',
            [request.params.highlightId, config.defaultUserId, deletedAt],
          );
          if (!deleted.rows[0]) throw new Error('highlight not found');
          const payload = { id: request.params.highlightId, deletedAt };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `highlight_deleted:${request.params.highlightId}:${deletedAt}`,
            type: 'highlight_deleted',
            bookId,
            entityId: request.params.highlightId,
            payload,
            revision: createServerRevision({
              entityType: 'highlight',
              entityId: request.params.highlightId,
              novelId: bookId,
              deletedAt,
              payload,
            }),
            createdAt: deletedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && error.message === 'highlight not found') {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/notes', async (request) => {
    const result = await pool.query(
      'select id, book_id, chapter_id, paragraph_id, quote, body, progress, created_at, updated_at from notes where book_id = $1 and user_id = $2 and deleted_at is null order by updated_at desc',
      [request.params.bookId, config.defaultUserId],
    );
    return { notes: mapNoteRows(result.rows) };
  });

  app.post<{ Params: { bookId: string }; Body: Record<string, unknown> }>(
    '/api/books/:bookId/notes',
    async (request, reply) => {
      const parsed = validateNoteBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const expectedRevision = expectedResourceRevision(request.body);
      const note = {
        ...parsed.value,
        novelId: request.params.bookId,
        bookId: request.params.bookId,
      };
      if (!(await hasBookChapterAccess(pool, config, request.params.bookId, note.chapterId))) {
        return reply.code(404).send({ error: 'book or chapter not found' });
      }
      try {
        const applied = await withTransaction(pool, async (db) => {
          if (!(await lockBookResource(db, config.defaultUserId, request.params.bookId))) {
            throw new Error('book not found');
          }
          if (!(await hasBookChapterAccess(db, config, request.params.bookId, note.chapterId))) {
            throw new Error('book or chapter not found');
          }
          await assertAnnotationContent(db, config.defaultUserId, request.params.bookId, request.body);
          await assertAnnotationCreate(db, 'notes', note.id, request.body);
          const actualRevision = await currentNoteRevision(db, config.defaultUserId, note.id);
          if (expectedRevision) assertServerResourceRevision('note', expectedRevision, actualRevision);
          const existing = actualRevision !== resourceEntityRevision('note', undefined);
          const saved = await db.query(
            `
          insert into notes (id, book_id, user_id, chapter_id, paragraph_id, quote, body, progress, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          on conflict (id) do update
            set quote = excluded.quote,
                body = excluded.body,
                progress = excluded.progress,
                updated_at = excluded.updated_at,
                deleted_at = null
            where notes.book_id = excluded.book_id
              and notes.user_id = excluded.user_id
              and notes.updated_at <= excluded.updated_at
          returning id
            `,
            [
              note.id,
              request.params.bookId,
              config.defaultUserId,
              note.chapterId,
              note.paragraphId,
              note.quote,
              note.body,
              note.progress ?? 0,
              note.createdAt,
              note.updatedAt,
            ],
          );
          if ((saved.rowCount ?? 0) === 0) return false;
          const type = existing ? 'note_updated' : 'note_created';
          const payload = { note };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `${type}:${note.id}:${note.updatedAt}`,
            type,
            bookId: request.params.bookId,
            entityId: note.id,
            payload,
            revision: createServerRevision({
              entityType: 'note',
              entityId: note.id,
              novelId: request.params.bookId,
              updatedAt: note.updatedAt,
              payload,
            }),
            createdAt: note.updatedAt,
          });
          return true;
        });
        if (!applied) return { ok: true, applied: false };
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && ['book not found', 'book or chapter not found'].includes(error.message)) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true, applied: true };
    },
  );

  app.delete<{ Params: { noteId: string }; Body: Record<string, unknown> }>(
    '/api/notes/:noteId',
    async (request, reply) => {
      const expectedRevision = expectedResourceRevision(request.body);
      const deletedAt = new Date().toISOString();
      try {
        await withTransaction(pool, async (db) => {
          const owner = await db.query('select book_id from notes where id = $1 and user_id = $2', [
            request.params.noteId,
            config.defaultUserId,
          ]);
          const bookId = owner.rows[0]?.book_id as string | undefined;
          if (!bookId || !(await lockBookResource(db, config.defaultUserId, bookId))) throw new Error('note not found');
          await assertAnnotationContent(db, config.defaultUserId, bookId, request.body);
          if (expectedRevision) {
            assertServerResourceRevision(
              'note',
              expectedRevision,
              await currentNoteRevision(db, config.defaultUserId, request.params.noteId),
            );
          }
          const deleted = await db.query(
            'update notes set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and deleted_at is null returning book_id',
            [request.params.noteId, config.defaultUserId, deletedAt],
          );
          if (!deleted.rows[0]) throw new Error('note not found');
          const payload = { id: request.params.noteId, deletedAt };
          await insertServerSyncEvent(db, config.defaultUserId, {
            seed: `note_deleted:${request.params.noteId}:${deletedAt}`,
            type: 'note_deleted',
            bookId,
            entityId: request.params.noteId,
            payload,
            revision: createServerRevision({
              entityType: 'note',
              entityId: request.params.noteId,
              novelId: bookId,
              deletedAt,
              payload,
            }),
            createdAt: deletedAt,
          });
        });
      } catch (error) {
        if (error instanceof ServerResourceRevisionConflictError) {
          return reply.code(409).send(resourceConflictPayload(error));
        }
        if (error instanceof Error && error.message === 'note not found') {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
      return { ok: true };
    },
  );
}
