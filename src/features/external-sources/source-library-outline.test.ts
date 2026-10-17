import { expect, it, vi } from 'vitest';
import { sourceLibraryOutline } from './source-library-outline';
import { sourceLibraryReaderModel } from './source-library-reader-model';
import type { ReaderOutlinePanelProps } from '../annotations/reader-outline-contract';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import type { SourceLibraryReader } from './use-source-library-reader';
import type { ExternalSourceItemView } from './external-source-controller-contract';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';

function fixture() {
  const chapter = testChapter(1, { novelId: 'book', documentSectionId: 'episode-2' });
  const items = [1, 2, 3].map((n) => ({
    key: { connectorId: 'fixture.text', remoteId: `episode-${n}` },
    title: `Episode ${n}`,
    release: { title: `Episode ${n}` },
  })) as ExternalSourceItemView[];
  const source: SourceLibraryReader = { novelId: 'book', items, busy: false, retry: vi.fn(), open: vi.fn() };
  const original = { novel: testNovel({ id: 'book' }), chapter, chapters: [chapter] } as unknown as ReaderScreenModel;
  const model = sourceLibraryReaderModel(original, source);
  const props: ReaderOutlinePanelProps = {
    chapters: [chapter],
    filteredChapters: [chapter],
    currentChapterId: chapter.id,
    readChapter: chapter,
    readChapterProgress: 0.5,
    annotationCounts: new Map([[chapter.id, { bookmarks: 1, highlights: 0, notes: 0 }]]),
    query: '',
    setQuery: vi.fn(),
    openChapter: vi.fn(async () => undefined),
  };
  return { source, original, model, props };
}
it('exposes the full catalogue, maps reading indexes and opens unsaved episodes through the import path', async () => {
  const { source, model, props } = fixture();
  const outline = sourceLibraryOutline(props, model, source);
  expect(outline.chapters).toHaveLength(3);
  expect(outline.filteredChapters).toBe(model.chapters);
  expect([...outline.pendingChapterIds!]).toEqual(['source-pending:episode-1', 'source-pending:episode-3']);
  expect(outline.readChapter?.index).toBe(2);
  expect(outline.readChapterProgress).toBe(0.5);
  expect(outline.annotationCounts.get(props.currentChapterId)?.bookmarks).toBe(1);
  await outline.openChapter(outline.chapters[2], false);
  expect(source.open).toHaveBeenCalledWith(source.items[2]);
  expect(props.openChapter).not.toHaveBeenCalled();
  expect(props.readChapter?.index).toBe(1);
});
it('uses the existing trimmed case-insensitive index/title query for remote entries', () => {
  const { source, model, props } = fixture();
  expect(
    sourceLibraryOutline({ ...props, query: ' EPISODE 3 ' }, model, source).filteredChapters.map((c) => c.id),
  ).toEqual(['source-pending:episode-3']);
  expect(
    sourceLibraryOutline({ ...props, query: '2 Episode' }, model, source).filteredChapters.map((c) => c.id),
  ).toEqual([props.currentChapterId]);
});
it('does not treat placeholders as saved progress or annotations', () => {
  const { source, model, props } = fixture();
  const placeholder = model.chapters[0];
  const result = sourceLibraryOutline(
    {
      ...props,
      readChapter: placeholder,
      annotationCounts: new Map([[placeholder.id, { bookmarks: 1, highlights: 1, notes: 1 }]]),
    },
    model,
    source,
  );
  expect(result.readChapter).toBeUndefined();
  expect(result.readChapterProgress).toBe(0);
  expect(result.annotationCounts.size).toBe(0);
});
it('keeps local/classic and unrelated source outlines unchanged, including restore', async () => {
  const { source, original, props } = fixture();
  expect(sourceLibraryOutline(props, original)).toBe(props);
  expect(sourceLibraryOutline(props, undefined, source)).toBe(props);
  expect(sourceLibraryOutline(props, original, { ...source, novelId: 'other' })).toBe(props);
  expect(sourceLibraryOutline(props, original, { ...source, items: [] })).toBe(props);
  await sourceLibraryOutline(props, original).openChapter(props.chapters[0], true);
  expect(props.openChapter).toHaveBeenCalledWith(props.chapters[0], true);
});

it.each([0, 1])('closes only after a successful open for catalogue row %i', async (index) => {
  const { source, model, props } = fixture();
  let finish!: (opened: boolean) => void;
  source.open = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  const outline = sourceLibraryOutline(props, model, source, close);
  const pending = outline.openChapter(outline.chapters[index], false);
  expect(close).not.toHaveBeenCalled();
  finish(true);
  await pending;
  expect(close).toHaveBeenCalledOnce();
});
it('retains the outline on rejected or unsuccessful opens', async () => {
  const { source, model, props } = fixture();
  const close = vi.fn();
  source.open = vi.fn(async () => false);
  const outline = sourceLibraryOutline(props, model, source, close);
  await outline.openChapter(outline.chapters[0], false);
  expect(close).not.toHaveBeenCalled();
  source.open = vi.fn(async () => {
    throw new Error('fixture failure');
  });
  await expect(outline.openChapter(outline.chapters[0], false)).rejects.toThrow('fixture failure');
  expect(close).not.toHaveBeenCalled();
});
