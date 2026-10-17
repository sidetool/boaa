import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testPosition,
  testWorkspaceState,
} from './book-workspace-test-fixtures';

describe('Reader return progress refresh', () => {
  it('publishes flushed progress to the selected book and library before opening source details', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-2', lastReadChapterIndex: 2, lastReadProgress: 1 / 3 });
    const fresh = testNovel({ lastReadChapterId: 'chapter-3', lastReadChapterIndex: 3, lastReadProgress: 2 / 3 });
    const other = testNovel({ id: 'other-book' });
    const harness = createBookWorkspaceTestHarness({ novel: fresh });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous, other],
        view: 'reader',
      }),
    );
    const returned = vi.fn((novel) => {
      expect(novel).toBe(fresh);
      expect(controller.getSnapshot()).toMatchObject({
        selectedNovel: fresh,
        novels: [fresh, other],
        view: 'chapters',
      });
    });

    await controller.returnToChaptersAndThen(returned);

    expect(returned).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual(['transition.stopReaderTTS', 'transition.flushReaderSession', 'repository.getNovel']);
  });

  it('keeps returning with the current book if the fresh progress lookup fails', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-2', lastReadProgress: 1 / 3 });
    const harness = createBookWorkspaceTestHarness({ novel: previous });
    harness.ports.repository.getNovel = vi.fn(async () => {
      throw new Error('temporary lookup failure');
    });
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous],
        view: 'reader',
      }),
    );
    const returned = vi.fn();

    await expect(controller.returnToChaptersAndThen(returned)).resolves.toBeUndefined();

    expect(returned).toHaveBeenCalledWith(previous);
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: previous, novels: [previous], view: 'chapters' });
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Reader return without a metadata round trip', () => {
  it('waits for durable progress, exposes chapters before metadata, and protects a new chapter from a late lookup', async () => {
    const previous = testNovel({ lastReadChapterId: 'chapter-1' });
    const fresh = testNovel({ lastReadChapterId: 'chapter-2' });
    const chapters = [testChapter(1), testChapter(2)];
    const harness = createBookWorkspaceTestHarness({ novel: fresh, chapters });
    const flush = deferred<void>();
    const metadata = deferred<typeof fresh>();
    const flushReaderSession = vi
      .spyOn(harness.ports.transition, 'flushReaderSession')
      .mockImplementationOnce(() => flush.promise);
    const getNovel = vi.spyOn(harness.ports.repository, 'getNovel').mockReturnValue(metadata.promise);
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous],
        chapters,
        currentChapter: chapters[0],
        view: 'reader',
      }),
    );

    const returning = controller.returnToChapters();
    expect(flushReaderSession).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().view).toBe('reader');
    expect(getNovel).not.toHaveBeenCalled();
    flush.resolve();
    await returning;
    expect(controller.getSnapshot()).toMatchObject({ view: 'chapters', selectedNovel: previous, chapters });
    expect(getNovel).toHaveBeenCalledOnce();

    await controller.openChapter(chapters[1]!);
    metadata.resolve(fresh);
    await metadata.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      view: 'reader',
      currentChapter: chapters[1],
      selectedNovel: previous,
      novels: [previous],
    });
  });

  it('keeps the explicit source-return callback waiting for fresh metadata', async () => {
    const previous = testNovel({ activeContentRevisionId: 'old' });
    const fresh = testNovel({ activeContentRevisionId: 'new', lastReadProgress: 0.75 });
    const oldChapters = [testChapter(1)];
    const newChapters = [testChapter(2, { id: 'source-return-new-chapter' })];
    const metadata = deferred<typeof fresh>();
    const harness = createBookWorkspaceTestHarness({ novel: fresh, chapters: newChapters });
    vi.spyOn(harness.ports.repository, 'getNovel').mockReturnValue(metadata.promise);
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({
        selectedNovel: previous,
        novels: [previous],
        chapters: oldChapters,
        currentChapter: oldChapters[0],
        view: 'reader',
      }),
    );
    const published: ReturnType<typeof controller.getSnapshot>[] = [];
    controller.subscribe(() => {
      const state = controller.getSnapshot();
      if (state.selectedNovel === fresh) published.push(state);
    });
    const returned = vi.fn();

    const returning = controller.returnToChaptersAndThen(returned);
    await vi.waitFor(() => expect(harness.ports.repository.getNovel).toHaveBeenCalledOnce());
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: previous, chapters: oldChapters, view: 'reader' });
    expect(returned).not.toHaveBeenCalled();
    metadata.resolve(fresh);
    await returning;
    expect(returned).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(controller.getSnapshot()).toMatchObject({ selectedNovel: fresh, chapters: newChapters, view: 'chapters' });
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((state) => state.view === 'chapters' && state.chapters === newChapters)).toBe(true);
  });

  it('publishes changed content metadata only together with its chapters and saved position', async () => {
    const previous = testNovel({ activeContentRevisionId: 'old' });
    const fresh = testNovel({ activeContentRevisionId: 'new' });
    const oldChapters = [testChapter(1)];
    const newChapters = [testChapter(2, { id: 'revision-new-chapter' })];
    const position = testPosition({ chapterId: newChapters[0]!.id });
    const chapters = deferred<typeof newChapters>();
    const harness = createBookWorkspaceTestHarness({ novel: fresh, position });
    vi.spyOn(harness.ports.repository, 'listChapters').mockReturnValue(chapters.promise);
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: previous, novels: [previous], chapters: oldChapters, view: 'reader' }),
    );
    const published: ReturnType<typeof controller.getSnapshot>[] = [];
    controller.subscribe(() => published.push(controller.getSnapshot()));

    await controller.returnToChapters();
    await vi.waitFor(() => expect(harness.ports.repository.listChapters).toHaveBeenCalledOnce());
    expect(controller.getSnapshot()).toMatchObject({
      view: 'chapters',
      selectedNovel: previous,
      chapters: oldChapters,
    });
    chapters.resolve(newChapters);
    await vi.waitFor(() => expect(controller.getSnapshot().selectedNovel).toBe(fresh));
    expect(controller.getSnapshot()).toMatchObject({
      novels: [fresh],
      chapters: newChapters,
      localReadingPosition: position,
    });
    expect(
      published
        .filter((state) => state.selectedNovel === fresh)
        .every((state) => state.chapters === newChapters && state.localReadingPosition === position),
    ).toBe(true);
  });

  it('discards a delayed revision refresh after another book is opened', async () => {
    const previous = testNovel({ activeContentRevisionId: 'old' });
    const fresh = testNovel({ activeContentRevisionId: 'new' });
    const other = testNovel({ id: 'other-book', activeContentRevisionId: 'other' });
    const oldChapters = [testChapter(1)];
    const refreshedChapters = [testChapter(2, { id: 'refreshed-chapter' })];
    const otherChapters = [testChapter(1, { id: 'other-chapter', novelId: other.id })];
    const chapters = deferred<typeof refreshedChapters>();
    const harness = createBookWorkspaceTestHarness({ novel: fresh });
    vi.spyOn(harness.ports.repository, 'listChapters').mockImplementation((id) =>
      id === previous.id ? chapters.promise : Promise.resolve(otherChapters),
    );
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: previous, novels: [previous, other], chapters: oldChapters, view: 'reader' }),
    );

    await controller.returnToChapters();
    await vi.waitFor(() => expect(harness.ports.repository.listChapters).toHaveBeenCalledWith(previous.id));
    await controller.openNovel(other);
    chapters.resolve(refreshedChapters);
    await chapters.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      selectedNovel: other,
      chapters: otherChapters,
      view: 'chapters',
      novels: [previous, other],
    });
  });

  it('keeps the previous revision usable when its replacement chapters fail to load', async () => {
    const previous = testNovel({ activeContentRevisionId: 'old' });
    const fresh = testNovel({ activeContentRevisionId: 'new' });
    const chapters = [testChapter(1)];
    const harness = createBookWorkspaceTestHarness({ novel: fresh });
    vi.spyOn(harness.ports.repository, 'listChapters').mockRejectedValue(new Error('temporary chapter failure'));
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ selectedNovel: previous, novels: [previous], chapters, view: 'reader' }),
    );

    await controller.returnToChaptersAndThen();
    expect(controller.getSnapshot()).toMatchObject({
      view: 'chapters',
      selectedNovel: previous,
      novels: [previous],
      chapters,
    });
  });

  it.each(['background', 'callback'] as const)(
    'returns a deleted book to the library during %s refresh',
    async (mode) => {
      const previous = testNovel();
      const deleted = testNovel({ deletedAt: '2026-10-15T09:00:00.000Z' });
      const chapters = [testChapter(1)];
      const metadata = deferred<typeof deleted>();
      const harness = createBookWorkspaceTestHarness();
      vi.spyOn(harness.ports.repository, 'getNovel').mockReturnValue(metadata.promise);
      const controller = new BookWorkspaceController(
        harness.ports,
        testWorkspaceState({
          selectedNovel: previous,
          novels: [previous],
          chapters,
          currentChapter: chapters[0],
          view: 'reader',
        }),
      );
      const returned = vi.fn();

      const returning =
        mode === 'background' ? controller.returnToChapters() : controller.returnToChaptersAndThen(returned);
      await vi.waitFor(() => expect(harness.ports.repository.getNovel).toHaveBeenCalledOnce());
      if (mode === 'background') {
        await returning;
        expect(controller.getSnapshot().view).toBe('chapters');
      }
      metadata.resolve(deleted);
      await returning;
      await vi.waitFor(() => expect(controller.getSnapshot().view).toBe('library'));
      expect(controller.getSnapshot()).toMatchObject({
        selectedNovel: deleted,
        novels: [deleted],
        chapters: [],
        currentChapter: undefined,
      });
      expect(returned).not.toHaveBeenCalled();
      expect(harness.calls).not.toContain('repository.listChapters');
    },
  );
});
