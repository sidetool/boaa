import { describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@boaa/text-core/hash';
import { parseNovelFileForImport } from '@boaa/text-core/parser';
import type { Novel } from '../../domain/types';
import { inspectImportDuplicates, MAX_IMPORT_DUPLICATE_HASH_BYTES } from './import-duplicate-inspection';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '기존 책',
    sourceFileName: 'book.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'hash',
    normalizedTextHash: 'hash',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 2,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

describe('inspectImportDuplicates', () => {
  it.each(['book.txt', 'renamed.txt'])('recognizes current parser source hashes for %s', async (name) => {
    const file = new File(['제1화 시작\n\n첫 본문\n\n제2화 다음\n\n둘째 본문'], name);
    const parsed = await parseNovelFileForImport('book.txt', await file.arrayBuffer(), 'utf-8', {
      chapterSplitMode: 'single',
    });
    const reparsed = await parseNovelFileForImport('book.txt', await file.arrayBuffer(), 'utf-8', {
      chapterSplitMode: 'mixed',
    });
    expect(parsed.novel.rawTextHash).toMatch(/^sha256:/);
    expect(reparsed.novel.rawTextHash).toBe(parsed.novel.rawTextHash);
    expect(reparsed.chapters.length).toBeGreaterThan(parsed.chapters.length);
    await expect(inspectImportDuplicates([file], [parsed.novel])).resolves.toEqual([
      expect.objectContaining({ kind: 'same_source', policy: 'open_existing', sourceHash: parsed.novel.rawTextHash }),
    ]);
    await expect(
      inspectImportDuplicates(
        [file],
        [{ ...parsed.novel, rawTextHash: parsed.novel.rawTextHash.slice(7).toUpperCase() }],
      ),
    ).resolves.toEqual([expect.objectContaining({ kind: 'same_source' })]);
  });

  it('distinguishes different bytes and does not upgrade legacy FNV digests', async () => {
    const file = new File(['new body'], 'book.txt');
    const hash = integrityHash(await file.arrayBuffer());
    for (const rawTextHash of [integrityHash('old body'), hash.slice(-8)]) {
      await expect(inspectImportDuplicates([file], [novel({ rawTextHash })])).resolves.toEqual([
        expect.objectContaining({ kind: 'same_name', policy: 'new' }),
      ]);
    }
    await expect(inspectImportDuplicates([new File(['new body'], 'different.txt')], [novel()])).resolves.toEqual([]);
  });

  it('skips duplicate hashing for an empty catalog', async () => {
    const file = new File(['body'], 'book.txt');
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(inspectImportDuplicates([file], [])).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns hashes only for exact inspected File objects, including nonconflicting files', async () => {
    const file = new File(['one'], 'new.txt', { lastModified: 1 });
    const other = new File(['two'], 'new.txt', { lastModified: 1 });
    const hashes = new Map<File, string>();
    await inspectImportDuplicates([file], [novel()], hashes);
    expect(hashes.get(file)).toBe(integrityHash('one'));
    expect(hashes.has(other)).toBe(false);
  });

  it('does not copy a large file into memory before upload and only checks its file name', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = {
      name: 'book.txt',
      size: MAX_IMPORT_DUPLICATE_HASH_BYTES + 1,
      lastModified: 1,
      type: 'text/plain',
      arrayBuffer,
    } as unknown as File;

    await expect(inspectImportDuplicates([file], [novel()])).resolves.toEqual([
      expect.objectContaining({ kind: 'same_name', policy: 'new', sourceHash: undefined }),
    ]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
