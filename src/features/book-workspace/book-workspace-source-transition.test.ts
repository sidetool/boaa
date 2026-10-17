import { expect, it, vi } from 'vitest';
import { BookWorkspaceController } from './book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testWorkspaceState,
} from './book-workspace-test-fixtures';
it('source transitions stop waiting for persistence', async () => {
  const novel = testNovel({ format: 'txt', activeContentRevisionId: 'revision' });
  const chapters = [testChapter(1), testChapter(2, { documentSectionId: 'next' })];
  const h = createBookWorkspaceTestHarness({ novel, chapters });
  let saved!: () => void;
  h.ports.transition.flushReaderSession = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  const load = vi.spyOn(h.ports.adjacent, 'loadReaderArtifacts');
  const controller = new BookWorkspaceController(
    h.ports,
    testWorkspaceState({ view: 'reader', selectedNovel: novel, currentChapter: chapters[0], chapters }),
  );
  const opening = controller.openDocumentSection(novel, 'next', undefined, chapters);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await opening;
  expect(controller.getSnapshot().currentChapter).toBe(chapters[1]);
  expect(load).toHaveBeenCalledWith(chapters[1].id, novel.id, { revision: 'revision', consume: true });
  saved();
  await opening;
});
