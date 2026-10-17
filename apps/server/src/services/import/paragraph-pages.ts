import type {
  Chapter,
  Paragraph,
  ParagraphPage,
  ParsedNovel,
  ParsedNovelImport,
  ParsedNovelImportChapter,
  ParsedNovelImportChapterSource,
} from '@boaa/contracts';
import { integrityHash } from '@boaa/text-core/hash';
import { paragraphPageId } from '@boaa/text-core/identity/parser';

const PARAGRAPHS_PER_PAGE = 120;

export function chunked<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += safeSize) {
    chunks.push(items.slice(start, start + safeSize));
  }
  return chunks;
}

function groupParagraphsByChapter(paragraphs: Paragraph[]): Map<string, Paragraph[]> {
  const paragraphsByChapter = new Map<string, Paragraph[]>();
  for (const paragraph of paragraphs) {
    const paragraphs = paragraphsByChapter.get(paragraph.chapterId) ?? [];
    paragraphs.push(paragraph);
    paragraphsByChapter.set(paragraph.chapterId, paragraphs);
  }

  for (const paragraphs of paragraphsByChapter.values()) {
    paragraphs.sort((a, b) => a.index - b.index);
  }

  return paragraphsByChapter;
}

function* iterateParsedNovelChapters(parsed: ParsedNovel): Generator<ParsedNovelImportChapter> {
  const paragraphsByChapter = groupParagraphsByChapter(parsed.paragraphs);
  for (const chapter of parsed.chapters) {
    yield {
      chapter,
      paragraphs: paragraphsByChapter.get(chapter.id) ?? [],
    };
  }
}

function paragraphPage(chapter: Chapter, pageIndex: number, paragraphs: Paragraph[]): ParagraphPage {
  return {
    id: paragraphPageId(chapter.novelId, chapter.id, pageIndex),
    novelId: chapter.novelId,
    chapterId: chapter.id,
    pageIndex,
    startParagraphIndex: paragraphs[0]?.index ?? 0,
    endParagraphIndex: paragraphs[paragraphs.length - 1]?.index ?? 0,
    paragraphs,
    textHash: integrityHash(JSON.stringify(paragraphs.map((paragraph) => paragraph.textHash))),
  };
}

export function* iterateChapterParagraphPages(
  chapter: Chapter,
  paragraphs: Iterable<Paragraph>,
): Generator<ParagraphPage> {
  let pageIndex = 0;
  let pageParagraphs: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    pageParagraphs.push(paragraph);
    if (pageParagraphs.length >= PARAGRAPHS_PER_PAGE) {
      yield paragraphPage(chapter, pageIndex, pageParagraphs);
      pageIndex += 1;
      pageParagraphs = [];
    }
  }
  if (pageParagraphs.length) yield paragraphPage(chapter, pageIndex, pageParagraphs);
}

function* iterateParagraphPages(chapterParagraphs: Iterable<ParsedNovelImportChapter>): Generator<ParagraphPage> {
  for (const { chapter, paragraphs } of chapterParagraphs) {
    yield* iterateChapterParagraphPages(chapter, paragraphs);
  }
}

async function* iterateParagraphPagesAsync(
  chapterParagraphs: ParsedNovelImportChapterSource,
): AsyncGenerator<ParagraphPage> {
  for await (const { chapter, paragraphs } of chapterParagraphs) {
    yield* iterateChapterParagraphPages(chapter, paragraphs);
  }
}

function* iterateParagraphPageBatchesFromChapters(
  chapterParagraphs: Iterable<ParsedNovelImportChapter>,
  batchSize: number,
): Generator<ParagraphPage[]> {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let batch: ParagraphPage[] = [];
  for (const page of iterateParagraphPages(chapterParagraphs)) {
    batch.push(page);
    if (batch.length >= safeBatchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

async function* iterateParagraphPageBatchesFromChaptersAsync(
  chapterParagraphs: ParsedNovelImportChapterSource,
  batchSize: number,
): AsyncGenerator<ParagraphPage[]> {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  let batch: ParagraphPage[] = [];
  for await (const page of iterateParagraphPagesAsync(chapterParagraphs)) {
    batch.push(page);
    if (batch.length >= safeBatchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export function* iterateParagraphPageBatches(parsed: ParsedNovel, batchSize: number): Generator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChapters(iterateParsedNovelChapters(parsed), batchSize);
}

function syncChapterSource(
  source: ParsedNovelImportChapterSource,
  operation: string,
): Iterable<ParsedNovelImportChapter> {
  if (Symbol.iterator in Object(source)) return source as Iterable<ParsedNovelImportChapter>;
  throw new TypeError(`${operation} requires a synchronous chapter source`);
}

export function* iterateImportParagraphPageBatches(
  parsed: ParsedNovelImport,
  batchSize: number,
): Generator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChapters(
    syncChapterSource(parsed.consumeChapterParagraphs(), 'iterateImportParagraphPageBatches'),
    batchSize,
  );
}

export async function* iterateImportParagraphPageBatchesAsync(
  parsed: ParsedNovelImport,
  batchSize: number,
): AsyncGenerator<ParagraphPage[]> {
  yield* iterateParagraphPageBatchesFromChaptersAsync(parsed.consumeChapterParagraphs(), batchSize);
}

export function buildParagraphPages(parsed: ParsedNovel): ParagraphPage[] {
  return Array.from(iterateParagraphPages(iterateParsedNovelChapters(parsed)));
}
