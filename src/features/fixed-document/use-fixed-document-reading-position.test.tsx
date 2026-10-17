import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { testChapter, testNovel, testPosition } from '../book-workspace/book-workspace-test-fixtures';
import { useFixedDocumentReadingPosition } from './use-fixed-document-reading-position';
import { useComicViewportPosition } from './use-comic-viewport-position';
vi.mock('./use-comic-viewport-position', () => ({ useComicViewportPosition: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
it('flushes the final viewport page/fraction even when navigation precedes the next render', async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  const chapters = [testChapter(1), testChapter(2)];
  const novel = testNovel();
  const save = vi.fn();
  let flush!: () => Promise<void>;
  function Harness() {
    flush = useFixedDocumentReadingPosition({
      identity: 'entry',
      novel,
      chapters,
      page: 0,
      ready: true,
      continuous: true,
      viewport: { current: null },
      content: { current: null },
      owner: save,
      save,
      readingPosition: testPosition({ chapterId: chapters[0].id, offsetInParagraph: 420_000 }),
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  const viewport = vi.mocked(useComicViewportPosition).mock.lastCall![0];
  expect(viewport.initial?.fraction).toBe(0.42);
  await act(async () => {
    viewport.save?.({ page: 1, fraction: 0.73, ratio: 3 });
    await flush();
  });
  expect(save).toHaveBeenLastCalledWith(1, chapters[1], novel, { page: 1, fraction: 0.73, ratio: 3 });
  await act(async () => {
    renderer.unmount();
  });
});
