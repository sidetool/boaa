import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { ReaderOpenRequest } from './reader-screen-contract';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { preparedSourceOpening } from './prepared-source-opening';
import { invalidateSharedParagraphPages, loadSharedParagraphPage } from './shared-paragraph-pages';
import { useParagraphPages } from './use-paragraph-pages';
const novel = testNovel({ activeContentRevisionId: 'revision' });
const chapter = testChapter(1, { documentSectionId: 'source-section', paragraphCount: 7 });
const request: ReaderOpenRequest = {
  chapterId: chapter.id,
  sequence: 1,
  restore: false,
  preserveSearch: false,
  fallbackScrollTop: 0,
};
const page = {
  paragraphs: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, index: i + 1, text: 'synthetic' })),
} as ParagraphPage;
it('seeds ready body content in the first viewport render without issuing another read', async () => {
  const getParagraphPage = vi.fn(async () => page);
  const repository = { getParagraphPage } as unknown as ReaderBodyRepository;
  expect(preparedSourceOpening(repository, novel, chapter, request)).toBeUndefined();
  await loadSharedParagraphPage(repository, 'revision', chapter.id, 0);
  const opening = preparedSourceOpening(repository, novel, chapter, request);
  expect(opening).toBe(page);
  const firstRender: unknown[] = [];
  function Harness() {
    const pages = useParagraphPages(repository, chapter.id, 7, 'revision', opening);
    firstRender.push(pages.paragraphAt(0));
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  expect(firstRender[0]).toBe(page.paragraphs[0]);
  expect(getParagraphPage).toHaveBeenCalledOnce();
  act(() => root.unmount());
  invalidateSharedParagraphPages(repository);
  expect(preparedSourceOpening(repository, novel, chapter, request)).toBeUndefined();
});
it('never bypasses restore, jumps, classic/local paths, other repositories or changed revisions', async () => {
  const repository = { getParagraphPage: vi.fn(async () => page) } as unknown as ReaderBodyRepository;
  await loadSharedParagraphPage(repository, 'revision', chapter.id, 0);
  for (const patch of [
    { restore: true },
    { targetParagraphId: 'p4' },
    { fallbackScrollTop: 10 },
    { chapterId: 'other' },
  ])
    expect(preparedSourceOpening(repository, novel, chapter, { ...request, ...patch })).toBeUndefined();
  expect(
    preparedSourceOpening(repository, novel, { ...chapter, documentSectionId: undefined }, request),
  ).toBeUndefined();
  expect(preparedSourceOpening({ ...repository }, novel, chapter, request)).toBeUndefined();
  expect(
    preparedSourceOpening(repository, { ...novel, activeContentRevisionId: 'new' }, chapter, request),
  ).toBeUndefined();
});
