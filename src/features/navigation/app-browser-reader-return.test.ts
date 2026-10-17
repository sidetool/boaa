import { describe, expect, it, vi } from 'vitest';
import { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testWorkspaceState,
} from '../book-workspace/book-workspace-test-fixtures';
import { restoreCurrentBookChapters } from './app-browser-reader-return';

type Target = Parameters<typeof restoreCurrentBookChapters>[1];
const target: Target = {
  view: 'chapters',
  bookId: 'book-1',
  chapters: { chapterQuery: 'saved query', chapterReadFilter: 'unread', chapterSort: 'desc' },
};

describe('reader browser history return', () => {
  it.each(['reader', 'document'] as const)(
    'restores saved chapter controls from %s without reopening the same detail',
    async (view) => {
      const novel = testNovel();
      const chapters = [testChapter(1)];
      const harness = createBookWorkspaceTestHarness({ novel, chapters });
      const controller = new BookWorkspaceController(
        harness.ports,
        testWorkspaceState({ view, selectedNovel: novel, chapters }),
      );
      const openNovel = vi.spyOn(controller, 'openNovel');
      const rendered: unknown[] = [];
      controller.subscribe(() => {
        const state = controller.getSnapshot();
        if (state.view === 'chapters')
          rendered.push({
            chapterQuery: state.chapterQuery,
            chapterReadFilter: state.chapterReadFilter,
            chapterSort: state.chapterSort,
          });
      });

      await expect(restoreCurrentBookChapters(controller, target)).resolves.toBe(true);

      expect(controller.getSnapshot()).toMatchObject({ view: 'chapters', chapters, ...target.chapters });
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.every((controls) => JSON.stringify(controls) === JSON.stringify(target.chapters))).toBe(true);
      expect(openNovel).not.toHaveBeenCalled();
      expect(harness.calls.filter((call) => call === 'repository.getNovel')).toHaveLength(1);
      expect(harness.calls).not.toContain('repository.listChapters');
      expect(harness.calls).not.toContain('repository.getReadingPosition');
      expect(harness.calls).not.toContain('adjacent.loadBookAnnotations');
    },
  );

  it.each([
    { name: 'source detail', changes: { source: { kind: 'source' } } },
    { name: 'synthetic detail', changes: { detailBookId: 'book-1' } },
    { name: 'another book', changes: { bookId: 'book-2' } },
    { name: 'missing book', changes: { bookId: undefined } },
    { name: 'another destination', changes: { view: 'library' as const } },
  ])('leaves $name to normal history restoration', async ({ changes }) => {
    const harness = createBookWorkspaceTestHarness();
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ view: 'reader', selectedNovel: testNovel() }),
    );
    const before = controller.getSnapshot();

    await expect(restoreCurrentBookChapters(controller, { ...target, ...changes })).resolves.toBe(false);

    expect(controller.getSnapshot()).toBe(before);
    expect(harness.calls).toEqual([]);
  });

  it('does not reuse a detail when already outside the reader', async () => {
    const harness = createBookWorkspaceTestHarness();
    const controller = new BookWorkspaceController(
      harness.ports,
      testWorkspaceState({ view: 'library', selectedNovel: testNovel() }),
    );
    await expect(restoreCurrentBookChapters(controller, target)).resolves.toBe(false);
    expect(harness.calls).toEqual([]);
  });
});
