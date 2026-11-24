import { expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import { BookPlaybackCoordinator, deferChapterPlayback } from '../../providers/book-playback-coordinator';
import type { BookWorkspaceReaderArtifacts } from '../book-workspace/book-workspace-contract';
import { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testWorkspaceState,
} from '../book-workspace/book-workspace-test-fixtures';
import { openChapterForPlayback, prepareNextTTSChapter } from './next-tts-chapter';
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

function chapterPlaybackFixture() {
  const book = testNovel();
  const first = testChapter(1);
  const second = testChapter(2);
  const chapters = [first, second];
  const { ports, calls, preparedOpens } = createBookWorkspaceTestHarness({ novel: book, chapters });
  let resolveCast!: (data: BookWorkspaceReaderArtifacts) => void;
  let rejectCast!: (cause: Error) => void;
  const cast = new Promise<BookWorkspaceReaderArtifacts>((resolve, reject) => {
    resolveCast = resolve;
    rejectCast = reject;
  });
  ports.adjacent.loadReaderArtifacts = vi.fn(() => cast);
  const workspace = new BookWorkspaceController(
    ports,
    testWorkspaceState({ view: 'reader', selectedNovel: book, chapters, currentChapter: first }),
  );
  const coordinator = new BookPlaybackCoordinator();
  const start = vi.fn();
  workspace.subscribe(() => {
    const active = workspace.getSnapshot().currentChapter;
    if (active) deferChapterPlayback(coordinator, book.id, active.id, start);
  });
  return {
    book,
    first,
    second,
    chapters,
    workspace,
    coordinator,
    start,
    calls,
    ports,
    preparedOpens,
    resolveCast,
    rejectCast,
  };
}

it.each(['resume', 'continue'] as const)(
  'starts plain %s in the target chapter while cast data is outstanding and keeps playing on failure',
  async (action) => {
    const f = chapterPlaybackFixture();
    const continuing = action === 'continue';
    const startIndex = continuing ? 0 : 2;
    const queueItemFingerprint = continuing ? undefined : 'saved-sentence';
    const target = { novel: f.book, chapter: f.second, chapters: continuing ? f.chapters : undefined };
    await openChapterForPlayback(f.coordinator, f.workspace, target, {
      listeningMode: 'plain',
      startIndex,
      queueItemFingerprint,
      preserveTTS: continuing,
    });
    expect(f.ports.adjacent.loadReaderArtifacts).toHaveBeenCalledOnce();
    expect(f.workspace.getSnapshot()).toMatchObject({ currentChapter: f.second, readerArtifactsStatus: 'loading' });
    expect(f.preparedOpens[0]?.options.initialMode).toBe('listen');
    expect(f.calls.includes('transition.stopChapterTTS')).toBe(!continuing);
    expect(f.start).toHaveBeenCalledExactlyOnceWith({
      bookId: f.book.id,
      chapterId: f.second.id,
      startIndex,
      queueItemFingerprint,
    });
    f.rejectCast(new Error('cast unavailable'));
    await Promise.resolve();
    expect(f.workspace.getSnapshot().readerArtifactsStatus).toBe('failed');
    expect(f.start).toHaveBeenCalledTimes(1);
  },
);

it('waits for target cast assignments before starting cast continuation', async () => {
  const f = chapterPlaybackFixture();
  const pending = openChapterForPlayback(
    f.coordinator,
    f.workspace,
    { novel: f.book, chapter: f.second },
    {
      listeningMode: 'cast',
      startIndex: 0,
      preserveTTS: true,
    },
  );
  await vi.waitFor(() => expect(f.ports.adjacent.loadReaderArtifacts).toHaveBeenCalledOnce());
  expect(f.workspace.getSnapshot().currentChapter).toBe(f.first);
  expect(f.start).not.toHaveBeenCalled();
  f.resolveCast({ segments: [], characters: [], voiceProfiles: [] });
  await pending;
  expect(f.workspace.getSnapshot().currentChapter).toBe(f.second);
  expect(f.preparedOpens[0]?.options.initialMode).toBe('listen');
  expect(f.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chapterId: f.second.id, startIndex: 0 }));
});

it('discards a failed cast resume before a later manual navigation to its chapter', async () => {
  const f = chapterPlaybackFixture();
  const pending = openChapterForPlayback(
    f.coordinator,
    f.workspace,
    { novel: f.book, chapter: f.second },
    {
      listeningMode: 'cast',
      startIndex: 2,
    },
  );
  await vi.waitFor(() => expect(f.ports.adjacent.loadReaderArtifacts).toHaveBeenCalledOnce());
  f.rejectCast(new Error('cast unavailable'));
  await expect(pending).rejects.toThrow('cast unavailable');
  await f.workspace.openChapter(f.second);
  expect(f.start).not.toHaveBeenCalled();
});
