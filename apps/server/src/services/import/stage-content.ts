import type pg from 'pg';
import type { Chapter, ParagraphPage } from '@boaa/contracts';
import { insertParagraphSearchBatch } from '../paragraph-search-persistence.js';

interface CommandQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

// These writes share the caller's activation transaction; this module never commits it.
export async function insertChapterBatch(client: pg.PoolClient, chapters: Chapter[]): Promise<void> {
  if (!chapters.length) return;
  const values: unknown[] = [];
  const rows = chapters.map((chapter) => {
    const offset = values.length;
    values.push(
      chapter.id,
      chapter.novelId,
      chapter.index,
      chapter.title,
      chapter.textHash,
      chapter.rawStartOffset,
      chapter.rawEndOffset,
      chapter.characterCount,
      chapter.paragraphCount,
      chapter.documentSectionId ?? null,
      chapter.documentSectionTitle ?? null,
      chapter.documentSectionIndex ?? null,
      chapter.documentPageIndexInSection ?? null,
      chapter.createdAt,
      chapter.updatedAt,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15})`;
  });

  const inserted = await client.query(
    `
      insert into chapters (
        id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
        character_count, paragraph_count, document_section_id, document_section_title,
        document_section_index, document_page_index_in_section, created_at, updated_at
      )
      values ${rows.join(', ')}
      on conflict (id) do update
        set chapter_index = excluded.chapter_index,
            title = excluded.title,
            text_hash = excluded.text_hash,
            raw_start_offset = excluded.raw_start_offset,
            raw_end_offset = excluded.raw_end_offset,
            character_count = excluded.character_count,
            paragraph_count = excluded.paragraph_count,
            document_section_id = excluded.document_section_id,
            document_section_title = excluded.document_section_title,
            document_section_index = excluded.document_section_index,
            document_page_index_in_section = excluded.document_page_index_in_section,
            updated_at = excluded.updated_at
      where chapters.book_id = excluded.book_id
    `,
    values,
  );
  if (inserted.rowCount !== chapters.length) throw new Error('import_chapter_parent_conflict');
}

export async function insertParagraphPageBatch(client: pg.PoolClient, pages: ParagraphPage[]): Promise<number> {
  if (!pages.length) return 0;
  const values: unknown[] = [];
  const rows = pages.map((page) => {
    const offset = values.length;
    values.push(
      page.id,
      page.novelId,
      page.chapterId,
      page.pageIndex,
      page.startParagraphIndex,
      page.endParagraphIndex,
      JSON.stringify(page.paragraphs),
      page.textHash,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
  });

  const inserted = await client.query(
    `
      insert into paragraph_pages (
        id, book_id, chapter_id, page_index, start_paragraph_index,
        end_paragraph_index, paragraphs, text_hash
      )
      values ${rows.join(', ')}
      on conflict (chapter_id, page_index) do update
        set paragraphs = excluded.paragraphs,
            text_hash = excluded.text_hash,
            start_paragraph_index = excluded.start_paragraph_index,
            end_paragraph_index = excluded.end_paragraph_index
      where paragraph_pages.book_id = excluded.book_id
    `,
    values,
  );

  if (inserted.rowCount !== pages.length) throw new Error('import_paragraph_parent_conflict');
  await insertParagraphSearchBatch(client, pages);

  return pages.reduce((sum, page) => sum + page.paragraphs.length, 0);
}

export async function replaceParsedBookContent(client: CommandQueryable, bookId: string): Promise<void> {
  await client.query('delete from paragraph_search where book_id = $1', [bookId]);
  await client.query('delete from paragraph_pages where book_id = $1', [bookId]);
  await client.query('delete from chapters where book_id = $1', [bookId]);
}
