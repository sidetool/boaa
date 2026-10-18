import { expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import { prepareNextTTSChapter } from './next-tts-chapter';
const novel = { id: 'book' } as Novel;
const current = { id: 'c1', novelId: 'book', index: 1, documentSectionId: 's1' } as Chapter;
const next = { ...current, id: 'c2', index: 2, documentSectionId: 's2' };
it('prepares the immediate source episode instead of skipping to an already-downloaded later episode', async () => {
  const prepare = vi.fn(async () => ({ novel, chapter: next, chapters: [current, next] }));
  const list = vi.fn(async () => [current, { ...next, id: 'c4', index: 4, documentSectionId: 's4' }]);
  const result = await prepareNextTTSChapter({
    novel,
    current,
    listChapters: list,
    source: {
      novelId: 'book',
      items: [
        { sectionId: 's1', prepare: async () => undefined },
        { sectionId: 's2', prepare },
        { sectionId: 's4', prepare: async () => undefined },
      ],
    },
  });
  expect(result?.chapter.id).toBe('c2');
  expect(prepare).toHaveBeenCalledOnce();
  expect(list).not.toHaveBeenCalled();
});
it('uses a fresh repository outline for local books and never treats a failed import as the last chapter', async () => {
  expect((await prepareNextTTSChapter({ novel, current, listChapters: async () => [next, current] }))?.chapter).toBe(
    next,
  );
  await expect(
    prepareNextTTSChapter({
      novel,
      current,
      listChapters: async () => [],
      source: {
        novelId: 'book',
        items: [
          { sectionId: 's1', prepare: async () => undefined },
          { sectionId: 's2', prepare: async () => undefined },
        ],
      },
    }),
  ).rejects.toThrow('다음 화');
});
it('rejects a prepared result from a different book/session or episode', async () => {
  await expect(
    prepareNextTTSChapter({
      novel,
      current,
      listChapters: async () => [],
      source: {
        novelId: 'book',
        items: [
          { sectionId: 's1', prepare: async () => undefined },
          { sectionId: 's2', prepare: async () => ({ novel: { ...novel, id: 'another' }, chapter: next }) },
        ],
      },
    }),
  ).rejects.toThrow('다음 화');
});
