import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { Novel } from '../../domain/types';

export function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book-1',
    title: '연결된 작품',
    sourceFileName: 'work.txt',
    sourceEncoding: 'utf-8',
    rawText: '기존 본문',
    normalizedText: '기존 본문',
    rawTextHash: 'old-raw-hash',
    normalizedTextHash: 'old-normalized-hash',
    sourceContentHash: 'old-source-hash',
    activeContentRevisionId: 'content-old',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    totalChapters: 1,
    totalCharacters: 5,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

export async function singlePageComicFile(): Promise<File> {
  const page = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  await writer.add('001.png', new Uint8ArrayReader(page));
  return new File([await writer.close()], '1화.cbz', { type: 'application/vnd.comicbook+zip' });
}
