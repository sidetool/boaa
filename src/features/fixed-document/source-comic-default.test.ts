import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { loadSourceComicProfile, isTallComicSample } from './source-comic-default';
import { IndexedDbComicReadingProfileRepository } from '../../storage/comic-reading-profile-store';
import { resetReaderDbForTests } from '../../storage/reader-database';
import { DEFAULT_COMIC_READING_PROFILE } from './comic-layout';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import type { FixedDocumentScreenProps } from './FixedDocumentScreen';

beforeEach(resetReaderDbForTests);
function fixture() {
  const getParagraphPage = vi.fn(async () => ({ paragraphs: [{ assetId: 'page' }] }));
  const getEmbeddedResource = vi.fn(async () => ({ blob: new Blob() }));
  const input = {
    novel: testNovel(),
    chapters: [1, 2, 3, 4].map((n) => testChapter(n)),
    repository: { getParagraphPage },
    assets: { getEmbeddedResource },
  } as unknown as FixedDocumentScreenProps;
  return { input, getParagraphPage, getEmbeddedResource, profiles: new IndexedDbComicReadingProfileRepository() };
}
it('uses a majority of the first three pages, requiring ratios strictly greater than two', () => {
  expect(
    isTallComicSample(
      [
        { width: 100, height: 300 },
        { width: 100, height: 201 },
      ],
      3,
    ),
  ).toBe(true);
  expect(
    isTallComicSample(
      [
        { width: 100, height: 200 },
        { width: 100, height: 300 },
      ],
      3,
    ),
  ).toBe(false);
  expect(isTallComicSample([{ width: 0, height: 300 }], 1)).toBe(false);
});
it.each(['source-profile', 'saved-novel'])(
  'detects tall pages for %s and persists a work-only automatic choice',
  async (key) => {
    const h = fixture();
    const profile = await loadSourceComicProfile(
      h.input,
      h.profiles,
      key,
      true,
      new AbortController().signal,
      vi.fn(async () => ({ width: 100, height: 300 })),
    );
    expect(profile).toMatchObject({ mode: 'vertical', seamlessVertical: true, fit: 'width' });
    expect(h.getEmbeddedResource).toHaveBeenCalledTimes(3);
    expect(await h.profiles.hasSaved(key)).toBe(true);
    expect(await h.profiles.hasSaved('another-work')).toBe(false);
    await loadSourceComicProfile(h.input, h.profiles, key, true, new AbortController().signal);
    expect(h.getEmbeddedResource).toHaveBeenCalledTimes(3);
  },
);
it('skips detection for classic/local paths and saved global or book preferences', async () => {
  const h = fixture();
  await loadSourceComicProfile(h.input, h.profiles, 'book', false, new AbortController().signal);
  expect(h.getParagraphPage).not.toHaveBeenCalled();
  await h.profiles.save('other', DEFAULT_COMIC_READING_PROFILE);
  const profile = await loadSourceComicProfile(h.input, h.profiles, 'book', true, new AbortController().signal);
  expect(profile.mode).toBe(DEFAULT_COMIC_READING_PROFILE.mode);
  expect(h.getParagraphPage).not.toHaveBeenCalled();
});
it('keeps a choice saved while probing and falls back safely when pages fail', async () => {
  const h = fixture();
  const profile = await loadSourceComicProfile(
    h.input,
    h.profiles,
    'book',
    true,
    new AbortController().signal,
    async () => {
      await h.profiles.save('book', { ...DEFAULT_COMIC_READING_PROFILE, mode: 'spread' });
      return { width: 100, height: 400 };
    },
  );
  expect(profile.mode).toBe('spread');
  await resetReaderDbForTests();
  h.getEmbeddedResource.mockRejectedValue(new Error('unavailable'));
  const fallback = await loadSourceComicProfile(h.input, h.profiles, 'book', true, new AbortController().signal);
  expect(fallback.mode).toBe(DEFAULT_COMIC_READING_PROFILE.mode);
});
it('cancels between pages without applying a stale profile', async () => {
  const h = fixture();
  const abort = new AbortController();
  await expect(
    loadSourceComicProfile(h.input, h.profiles, 'book', true, abort.signal, async () => {
      abort.abort();
      return { width: 100, height: 400 };
    }),
  ).rejects.toThrow();
  expect(h.getEmbeddedResource).toHaveBeenCalledTimes(1);
});
