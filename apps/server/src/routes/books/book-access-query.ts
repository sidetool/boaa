import pg from 'pg';
import type { ServerConfig } from '../../config.js';

export async function hasBookChapterAccess(
  pool: Pick<pg.Pool, 'query'>,
  config: ServerConfig,
  bookId: string,
  chapterId: string,
  documentSectionId?: string,
  paragraphId?: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
      select exists(
        select 1
        from chapters c
        join library_books b on b.id = c.book_id
        where b.id = $1 and b.user_id = $2 and b.deleted_at is null and c.id = $3
          and ($4::text is null or c.document_section_id=$4)
          and ($5::text is null or exists (select 1 from paragraph_search p where p.paragraph_id=$5 and p.book_id=b.id and p.chapter_id=c.id))
      ) as exists
    `,
    [bookId, config.defaultUserId, chapterId, documentSectionId ?? null, paragraphId ?? null],
  );
  return result.rows[0]?.exists === true;
}
