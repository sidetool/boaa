import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMIC_READING_PROFILE } from '../features/fixed-document/comic-layout';
import { IndexedDbComicReadingProfileRepository } from './comic-reading-profile-store';
import { resetReaderDbForTests } from './reader-database';

describe('comic reading profile store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('reuses display settings globally while keeping detected page crops with their book', async () => {
    const repository = new IndexedDbComicReadingProfileRepository();
    await repository.save('book-a', {
      ...DEFAULT_COMIC_READING_PROFILE,
      mode: 'vertical',
      seamlessVertical: true,
      fit: 'width',
      background: 'black',
      pageTurnMotion: 'page',
      pageCrops: { '3': { top: 0.01, right: 0.02, bottom: 0.03, left: 0.04 } },
    });

    await expect(repository.get('book-b')).resolves.toMatchObject({
      mode: 'vertical',
      seamlessVertical: true,
      fit: 'width',
      background: 'black',
      pageTurnMotion: 'page',
      pageCrops: undefined,
    });
    await expect(repository.get('book-a')).resolves.toMatchObject({
      pageCrops: { '3': { top: 0.01, right: 0.02, bottom: 0.03, left: 0.04 } },
    });
  });
  it('shares work display settings without leaking crops between episodes or revisions', async () => {
    const repository = new IndexedDbComicReadingProfileRepository();
    const crop = { top: 0.1, left: 0, right: 0, bottom: 0 };
    await repository.save(
      'work',
      { ...DEFAULT_COMIC_READING_PROFILE, fit: 'width', pageCrops: { '0': crop } },
      'episode-a:revision-1',
    );
    expect((await repository.get('work', {}, 'episode-a:revision-1')).pageCrops).toEqual({ '0': crop });
    expect((await repository.get('work', {}, 'episode-b:revision-1')).pageCrops).toBeUndefined();
    expect((await repository.get('work', {}, 'episode-a:revision-2')).pageCrops).toBeUndefined();
    expect((await repository.get('work', {}, 'episode-b:revision-1')).fit).toBe('width');
  });
});
