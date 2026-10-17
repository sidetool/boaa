import { describe, expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { loadSharedParagraphPage } from '../reader/shared-paragraph-pages';
import { BookWorkspaceController } from './book-workspace-controller';
import type { BookWorkspaceReaderArtifacts, BookWorkspaceReaderOpenOptions } from './book-workspace-contract';
import { preloadBookWorkspaceReaderBody } from './book-workspace-reader-preload';
import { createBookWorkspacePortProxy } from './book-workspace-port-proxy';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testPosition,
  testWorkspaceState,
} from './book-workspace-test-fixtures';

const page = { paragraphs: [] } as unknown as ParagraphPage;
const repositoryFor = (getParagraphPage: ReaderBodyRepository['getParagraphPage']) =>
  ({ getParagraphPage }) as ReaderBodyRepository;

describe('reader opening body preload', () => {
  it('shares the pending opening page with the foreground reader and retains the completed page', async () => {
    let finish!: (value: ParagraphPage) => void;
    const getParagraphPage = vi.fn(
      () =>
        new Promise<ParagraphPage>((resolve) => {
          finish = resolve;
        }),
    );
    const repository = repositoryFor(getParagraphPage);
    const novel = testNovel({ activeContentRevisionId: 'revision-1' });
    const chapter = testChapter(1, { paragraphCount: PARAGRAPHS_PER_PAGE * 4 });

    preloadBookWorkspaceReaderBody(repository, novel, chapter, {});
    preloadBookWorkspaceReaderBody(repository, novel, chapter, {});
    const foreground = loadSharedParagraphPage(repository, 'revision-1', chapter.id, 0);
    expect(getParagraphPage).toHaveBeenCalledExactlyOnceWith(chapter.id, 0);
    finish(page);
    await expect(foreground).resolves.toBe(page);
    await expect(loadSharedParagraphPage(repository, 'revision-1', chapter.id, 0)).resolves.toBe(page);
    expect(getParagraphPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { paragraphIndex: 1, expectedPage: 0 },
    { paragraphIndex: PARAGRAPHS_PER_PAGE, expectedPage: 0 },
    { paragraphIndex: PARAGRAPHS_PER_PAGE + 1, expectedPage: 1 },
    { paragraphIndex: PARAGRAPHS_PER_PAGE * 20, expectedPage: 2 },
  ])('restores paragraph $paragraphIndex by preloading only page $expectedPage', ({ paragraphIndex, expectedPage }) => {
    const getParagraphPage = vi.fn(async () => page);
    const repository = repositoryFor(getParagraphPage);
    const chapter = testChapter(2, { paragraphCount: PARAGRAPHS_PER_PAGE * 3 });
    preloadBookWorkspaceReaderBody(repository, testNovel(), chapter, {
      restore: true,
      position: testPosition({ chapterId: chapter.id, paragraphIndex }),
    });
    expect(getParagraphPage).toHaveBeenCalledExactlyOnceWith(chapter.id, expectedPage);
  });

  it.each([
    { name: 'explicit paragraph target', options: { targetParagraphId: 'paragraph-9' } },
    { name: 'another chapter position', options: { restore: true, position: testPosition({ chapterId: 'other' }) } },
    { name: 'unknown paragraph index', options: { restore: true, position: testPosition({ paragraphIndex: 0 }) } },
  ] satisfies Array<{ name: string; options: BookWorkspaceReaderOpenOptions }>)(
    'skips speculative loading for $name',
    ({ options }) => {
      const getParagraphPage = vi.fn(async () => page);
      preloadBookWorkspaceReaderBody(repositoryFor(getParagraphPage), testNovel(), testChapter(2), options);
      expect(getParagraphPage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { lastReadChapterId: undefined, lastReadOffset: 0 },
    { lastReadChapterId: 'chapter-2', lastReadOffset: 0 },
    { lastReadChapterId: 'other-chapter', lastReadOffset: 240 },
  ])(
    'preloads page zero on first entry without a structured position ($lastReadChapterId/$lastReadOffset)',
    (progress) => {
      const getParagraphPage = vi.fn(async () => page);
      preloadBookWorkspaceReaderBody(repositoryFor(getParagraphPage), testNovel(progress), testChapter(2), {
        restore: true,
      });
      expect(getParagraphPage).toHaveBeenCalledExactlyOnceWith('chapter-2', 0);
    },
  );

  it('skips guessing a page from a legacy scroll offset in the same chapter', () => {
    const getParagraphPage = vi.fn(async () => page);
    preloadBookWorkspaceReaderBody(
      repositoryFor(getParagraphPage),
      testNovel({ lastReadChapterId: 'chapter-2', lastReadOffset: 240 }),
      testChapter(2),
      { restore: true },
    );
    expect(getParagraphPage).not.toHaveBeenCalled();
  });

  it('skips chapters with no body paragraphs', () => {
    const getParagraphPage = vi.fn(async () => page);
    preloadBookWorkspaceReaderBody(
      repositoryFor(getParagraphPage),
      testNovel(),
      testChapter(1, { paragraphCount: 0 }),
      {},
    );
    expect(getParagraphPage).not.toHaveBeenCalled();
  });

  it('allows the foreground reader to retry a failed preload', async () => {
    const getParagraphPage = vi
      .fn<ReaderBodyRepository['getParagraphPage']>()
      .mockRejectedValueOnce(new Error('temporary body failure'))
      .mockResolvedValue(page);
    const repository = repositoryFor(getParagraphPage);
    const novel = testNovel({ activeContentRevisionId: 'revision-1' });
    const chapter = testChapter(1);

    preloadBookWorkspaceReaderBody(repository, novel, chapter, {});
    await expect(loadSharedParagraphPage(repository, 'revision-1', chapter.id, 0)).rejects.toThrow(
      'temporary body failure',
    );
    await expect(loadSharedParagraphPage(repository, 'revision-1', chapter.id, 0)).resolves.toBe(page);
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an opening body across content revisions', async () => {
    const getParagraphPage = vi.fn(async () => page);
    const repository = repositoryFor(getParagraphPage);
    const chapter = testChapter(1);
    preloadBookWorkspaceReaderBody(repository, testNovel({ activeContentRevisionId: 'old' }), chapter, {});
    await loadSharedParagraphPage(repository, 'old', chapter.id, 0);
    preloadBookWorkspaceReaderBody(repository, testNovel({ activeContentRevisionId: 'new' }), chapter, {});
    await loadSharedParagraphPage(repository, 'new', chapter.id, 0);
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
  });

  it('starts the opening body through the port proxy before delayed reader artifacts complete', async () => {
    const novel = testNovel({ activeContentRevisionId: 'proxy-revision' });
    const chapter = testChapter(1);
    const getParagraphPage = vi.fn(async () => page);
    const repository = repositoryFor(getParagraphPage);
    const harness = createBookWorkspaceTestHarness({ novel, chapters: [chapter] });
    const preload = vi.fn((novel, chapter, options) =>
      preloadBookWorkspaceReaderBody(repository, novel, chapter, options),
    );
    harness.ports.adjacent.preloadReaderBody = preload;
    let finish!: () => void;
    harness.ports.adjacent.loadReaderArtifacts = vi.fn(
      () =>
        new Promise<BookWorkspaceReaderArtifacts>((resolve) => {
          finish = () => resolve({ segments: [], characters: [], voiceProfiles: [] });
        }),
    );
    const controller = new BookWorkspaceController(
      createBookWorkspacePortProxy({
        repository: harness.ports.repository,
        transition: { current: harness.ports.transition },
        adjacent: { current: harness.ports.adjacent },
        environment: harness.ports.environment,
      }),
      testWorkspaceState({ selectedNovel: novel, chapters: [chapter], view: 'chapters' }),
    );
    const opening = controller.openChapter(chapter, { restore: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(preload).toHaveBeenCalledExactlyOnceWith(novel, chapter, { restore: true });
    await expect(loadSharedParagraphPage(repository, 'proxy-revision', chapter.id, 0)).resolves.toBe(page);
    expect(getParagraphPage).toHaveBeenCalledExactlyOnceWith(chapter.id, 0);
    expect(controller.getSnapshot().view).toBe('chapters');
    finish();
    await opening;
    expect(controller.getSnapshot()).toMatchObject({ view: 'reader', currentChapter: chapter });
  });
});
