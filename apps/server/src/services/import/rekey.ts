import type { Chapter, Paragraph, ParsedNovel, ParsedNovelImport, ParsedNovelImportChapter } from '@boaa/contracts';
import { parsedChapterId, parsedParagraphId } from '@boaa/text-core/identity/parser';

export function rekeyParsedNovel(parsed: ParsedNovel, targetBookId?: string | null): ParsedNovel {
  const bookId = targetBookId?.trim();
  if (!bookId || bookId === parsed.novel.id) return parsed;

  const chapterIdByOriginal = new Map<string, string>();
  const chapters = parsed.chapters.map((chapter) => {
    const chapterId = parsedChapterId(bookId, chapter.index, chapter.title);
    chapterIdByOriginal.set(chapter.id, chapterId);
    return {
      ...chapter,
      id: chapterId,
      novelId: bookId,
    };
  });
  const paragraphs = parsed.paragraphs.map((paragraph) => {
    const chapterId = chapterIdByOriginal.get(paragraph.chapterId) ?? paragraph.chapterId;
    return {
      ...paragraph,
      id: parsedParagraphId(bookId, chapterId, paragraph.index - 1, paragraph.text),
      novelId: bookId,
      chapterId,
    };
  });
  return {
    novel: {
      ...parsed.novel,
      id: bookId,
      lastReadChapterId: chapters[0]?.id,
      lastReadParagraphId: undefined,
    },
    chapters,
    paragraphs,
  };
}

export function rekeyParsedNovelImport(parsed: ParsedNovelImport, targetBookId?: string | null): ParsedNovelImport {
  const bookId = targetBookId?.trim();
  if (!bookId || bookId === parsed.novel.id) return parsed;

  const chapterByOriginal = new Map<string, Chapter>();
  const chapters = parsed.chapters.map((chapter) => {
    const rekeyed: Chapter = {
      ...chapter,
      id: parsedChapterId(bookId, chapter.index, chapter.title),
      novelId: bookId,
    };
    chapterByOriginal.set(chapter.id, rekeyed);
    return rekeyed;
  });
  let consumed = false;
  const rekeyParagraphs = function* (chapter: Chapter, paragraphs: Iterable<Paragraph>): Generator<Paragraph> {
    for (const paragraph of paragraphs) {
      yield {
        ...paragraph,
        id: parsedParagraphId(bookId, chapter.id, paragraph.index - 1, paragraph.text),
        novelId: bookId,
        chapterId: chapter.id,
      };
    }
  };
  const rekeyChapterParagraphs = (item: ParsedNovelImportChapter): ParsedNovelImportChapter => {
    const chapter = chapterByOriginal.get(item.chapter.id) ?? item.chapter;
    return {
      chapter,
      paragraphs: rekeyParagraphs(chapter, item.paragraphs),
    };
  };

  return {
    novel: {
      ...parsed.novel,
      id: bookId,
      rawText: '',
      normalizedText: '',
      lastReadChapterId: chapters[0]?.id,
      lastReadParagraphId: undefined,
    },
    chapters,
    consumeChapterParagraphs() {
      if (consumed) return [];
      consumed = true;
      const source = parsed.consumeChapterParagraphs();
      if (Symbol.asyncIterator in Object(source)) {
        return (async function* () {
          for await (const item of source) yield rekeyChapterParagraphs(item);
        })();
      }
      return (function* () {
        for (const item of source as Iterable<ParsedNovelImportChapter>) yield rekeyChapterParagraphs(item);
      })();
    },
  };
}
