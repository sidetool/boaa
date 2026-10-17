import { expect, it, vi } from 'vitest';
import { sourceStreamDocument } from './source-stream-document';

it('keeps work and episode identities separate while reading image pages', async () => {
  const loadPage = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
  const session = { pageCount: 2, loadPage, close: vi.fn() };
  const projection = sourceStreamDocument('source-id', 'Episode 6', session, vi.fn(), 'Fixture Work');
  expect(projection.novel.title).toBe('Fixture Work');
  expect(projection.chapters.map((chapter) => chapter.documentSectionTitle)).toEqual(['Episode 6', 'Episode 6']);
  const page = await projection.repository.getParagraphPage(projection.chapters[0].id, 0);
  await projection.assets.getEmbeddedResource('source-id', page!.paragraphs[0].assetId!);
  expect(loadPage).toHaveBeenCalledWith(0, expect.any(AbortSignal));
});
it('keeps the old episode fallback when callers do not have work metadata', () => {
  const projection = sourceStreamDocument(
    'id',
    'Episode',
    { pageCount: 1, loadPage: vi.fn(), close: vi.fn() },
    vi.fn(),
  );
  expect(projection.novel.title).toBe('Episode');
});
