import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { useSourceLibraryProgress } from './use-source-library-progress';
import { fixture } from './source-command-test-fixtures';
import { sourceLibraryPosition } from './source-library-position';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import type { ExternalItemSummary, ExternalSourceLink } from '../../external-sources/contracts';
import { withSourceProgress } from '../library/library-source-progress';
import { buildLibraryBookView } from '../library/library-screen-model';
import { bookHeroLabels } from '../../ui-next/home/hero-labels';
import { bookProgress } from '../../ui-next/library/model';

export function positionFixture() {
  const novel = testNovel({
    id: 'book',
    format: 'txt',
    lastReadChapterId: 'saved-6',
    lastReadChapterIndex: 3,
    totalChapters: 3,
  });
  const chapters = [1, 2, 6].map((n, i) =>
    testChapter(i + 1, { id: `saved-${n}`, novelId: novel.id, title: `${n}화`, documentSectionId: `remote-${n}` }),
  );
  const links: ExternalSourceLink[] = [1, 2, 6].map((n) => ({
    id: `link-${n}`,
    source: { connectorId: 'fixture.source', remoteId: `remote-${n}` },
    localBookId: novel.id,
    collectionRemoteId: 'work',
    linkedAt: '2026-01-01',
  }));
  const catalog: ExternalItemSummary[] = Array.from({ length: 40 }, (_, i) => ({
    key: { connectorId: 'fixture.source', remoteId: `remote-${i + 1}` },
    kind: 'file',
    importability: 'supported',
    title: `${i + 1}화`,
    release: { title: `${i + 1}화`, sourceOrder: i + 1 },
  }));
  return { novel, chapters, links, catalog };
}
it('projects episode six of forty instead of saved chapter three of three, including CTA and tiles', () => {
  const { novel, chapters, links, catalog } = positionFixture();
  const position = sourceLibraryPosition(novel, chapters, links, catalog, 40)!;
  expect(position).toMatchObject({ episodeNumber: 6, position: 6, total: 40, progress: 0.15 });
  const local = buildLibraryBookView(novel, { hasReadActivity: () => true, isFinished: () => true });
  const book = withSourceProgress(local, { readCount: 6, totalCount: 40, progress: 0.15, sourcePosition: position });
  expect(book.isFinished).toBe(false);
  expect(book.readingCounts).toEqual({ current: 6, total: 40, unit: '화' });
  expect(bookProgress(book)).toMatchObject({ episodeNumber: 6, current: 6, total: 40, percent: 15 });
  expect(bookHeroLabels(book, 'continue', { index: 3, title: '6화' }).resumeLabel).toBe('6화 이어 읽기');
});
it('handles descending catalogues and an incomplete cache with a known subscription total', () => {
  const f = positionFixture();
  expect(sourceLibraryPosition(f.novel, f.chapters, f.links, [...f.catalog].reverse(), 40)?.position).toBe(6);
  expect(sourceLibraryPosition(f.novel, f.chapters, f.links, [], 40)?.episodeNumber).toBe(6);
  expect(sourceLibraryPosition(f.novel, f.chapters, f.links, [], 0)).toBeUndefined();
  expect(sourceLibraryPosition(f.novel, f.chapters, [], f.catalog, 40)).toBeUndefined();
});

it('restores source totals from the cached reader catalogue even without a subscription record', async () => {
  const f = positionFixture();
  const port = fixture();
  port.options.state.getCachePage = vi.fn(async () => ({
    items: f.catalog,
    completeSeries: true,
  })) as unknown as typeof port.options.state.getCachePage;
  const input = {
    novels: [f.novel],
    links: f.links,
    subscriptions: [],
    preferences: [],
    listChapters: vi.fn(async () => f.chapters),
  };
  let current!: ReturnType<typeof useSourceLibraryProgress>;
  function Harness() {
    current = useSourceLibraryProgress(port.options, input);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Harness));
  });
  try {
    expect(current.byNovelId.get(f.novel.id)).toMatchObject({
      totalCount: 40,
      progress: 0.15,
      sourcePosition: { episodeNumber: 6 },
    });
    expect(port.registry.listExternalSource).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
