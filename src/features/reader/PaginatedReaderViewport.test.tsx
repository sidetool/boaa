import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderPageBoundary } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';
import { loadReaderPageMap, type StoredReaderPageMap } from '../../storage/reader-page-map-store';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { PaginatedReaderViewport } from './PaginatedReaderViewport';
import { ReaderScreenHandle } from './reader-screen-contract';
import type { ReaderViewportApi, ReaderViewportLayerProps } from './ReaderViewport';

vi.mock('../../storage/reader-page-map-store', () => ({
  loadReaderPageMap: vi.fn(),
  saveReaderPageMap: vi.fn(),
  pruneReaderPageMaps: vi.fn(),
}));
vi.mock('./use-reader-progress', () => {
  const persistence = { schedule: vi.fn(), flush: vi.fn(async () => undefined) };
  return { useReaderPositionPersistence: () => persistence };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('inactive pagination work', () => {
  it('keeps the visible page map when only the book revision changes', async () => {
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.stubGlobal('window', { clearTimeout: vi.fn(), cancelAnimationFrame: vi.fn() });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { fonts: { ready: Promise.resolve() } }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const chapter = testChapter(1, {
      id: 'stable-pagination-fixture',
      novelId: 'book',
      paragraphCount: 1,
      textHash: 'unchanged-body',
    });
    const paragraph = {
      id: 'paragraph',
      novelId: 'book',
      chapterId: chapter.id,
      index: 1,
      text: '원문',
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    };
    const anchor = {
      bookId: 'book',
      contentRevisionId: 'revision-1',
      sectionId: chapter.id,
      blockId: 'paragraph',
      blockIndex: 0,
      offset: 0,
    };
    vi.mocked(loadReaderPageMap).mockResolvedValue({
      id: 'stable-pagination-map',
      chapterId: chapter.id,
      contentRevisionId: anchor.contentRevisionId,
      layoutKey: 'fixture-layout',
      rendererVersion: 'fixture-renderer',
      boundaries: [{ index: 0, start: anchor, end: { ...anchor, offset: 2 } }],
      createdAt: '2026-09-08T00:00:00.000Z',
      lastAccessedAt: '2026-09-08T00:00:00.000Z',
    });
    const props = {
      chapter,
      chapters: [chapter],
      repository: { getParagraphPage: vi.fn(async () => ({ paragraphs: [paragraph] })) },
      settings: defaultSettings,
      mode: 'read',
      search: { highlightQuery: '' },
      screenHandle: new ReaderScreenHandle(),
      apiRef: {},
      onApiReady: vi.fn(),
      onVisualLocation: vi.fn(),
      onPaginationFailure: vi.fn(),
      isActive: true,
    } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
    let renderer!: ReactTestRenderer;
    const render = (revision: string, textHash = chapter.textHash) => (
      <PaginatedReaderViewport
        {...props}
        novel={testNovel({ id: 'book', activeContentRevisionId: revision, totalChapters: 1 })}
        chapter={{ ...chapter, textHash }}
      />
    );
    try {
      await act(async () => {
        renderer = create(render('revision-1'), {
          createNodeMock: () => ({ clientWidth: 800, clientHeight: 600, replaceChildren: vi.fn() }),
        });
      });
      expect(loadReaderPageMap).toHaveBeenCalledTimes(1);

      await act(async () => renderer.update(render('revision-2')));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(1);

      await act(async () => renderer.update(render('revision-2', 'changed-body')));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(2);
    } finally {
      act(() => renderer?.unmount());
    }
  });

  it.each([false, true])(
    'reserves measured space for search and restores ordinary placement (cross chapter: %s)',
    async (crossChapter) => {
      const idleCallbacks: Array<() => void> = [];
      vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));
      vi.stubGlobal('cancelIdleCallback', vi.fn());
      vi.stubGlobal(
        'window',
        Object.assign(new EventTarget(), {
          clearTimeout: vi.fn(),
          cancelAnimationFrame: vi.fn(),
          getComputedStyle: () => ({ paddingTop: '60', visibility: 'visible', display: 'block', opacity: '1' }),
        }),
      );
      vi.stubGlobal('document', Object.assign(new EventTarget(), { fonts: { ready: Promise.resolve() } }));
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
      const chapter = testChapter(1, {
        id: `search-pagination-${crossChapter}`,
        novelId: 'book',
        paragraphCount: 1,
        textHash: 'unchanged-body',
      });
      const paragraph = {
        id: 'paragraph',
        novelId: 'book',
        chapterId: chapter.id,
        index: 1,
        text: '원문',
        startOffsetInChapter: 0,
        endOffsetInChapter: 2,
        textHash: 'fixture-text',
        createdAt: '2026-09-08T00:00:00.000Z',
        updatedAt: '2026-09-08T00:00:00.000Z',
      };
      const anchor = {
        bookId: 'book',
        contentRevisionId: 'revision-1',
        sectionId: chapter.id,
        blockId: 'paragraph',
        blockIndex: 0,
        offset: 0,
      };
      vi.mocked(loadReaderPageMap).mockResolvedValue({
        id: 'stable-pagination-map',
        chapterId: chapter.id,
        contentRevisionId: anchor.contentRevisionId,
        layoutKey: 'fixture-layout',
        rendererVersion: 'fixture-renderer',
        boundaries: [{ index: 0, start: anchor, end: { ...anchor, offset: 2 } }],
        createdAt: '2026-09-08T00:00:00.000Z',
        lastAccessedAt: '2026-09-08T00:00:00.000Z',
      });
      const props = {
        chapter,
        chapters: [chapter],
        repository: {
          getParagraph: vi.fn(async () => paragraph),
          getParagraphPage: vi.fn(async () => ({ paragraphs: [paragraph] })),
        },
        settings: defaultSettings,
        mode: 'read',
        search: { highlightQuery: '원문' },
        screenHandle: new ReaderScreenHandle(),
        apiRef: { current: undefined } as { current?: ReaderViewportApi },
        openRequest: crossChapter ? { sequence: 1, targetParagraphId: paragraph.id, preserveSearch: true } : undefined,
        onApiReady: vi.fn(),
        onVisualLocation: vi.fn(),
        onPaginationFailure: vi.fn(),
        isActive: true,
      } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
      let renderer!: ReactTestRenderer;
      const render = (revision: string, textHash = chapter.textHash) => (
        <PaginatedReaderViewport
          {...props}
          novel={testNovel({ id: 'book', activeContentRevisionId: revision, totalChapters: 1 })}
          chapter={{ ...chapter, textHash }}
        />
      );
      const screen = Object.assign(new EventTarget(), {
        querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 66, bottom: 300, left: 0, right: 800 }) }],
      });
      try {
        await act(async () => {
          renderer = create(render('revision-1'), {
            createNodeMock: () => ({
              clientWidth: 800,
              clientHeight: 600,
              replaceChildren: vi.fn(),
              closest: () => screen,
              getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 800 }),
            }),
          });
        });
        const stage = () =>
          renderer.root.find(
            (node) =>
              typeof node.props.className === 'string' && node.props.className.startsWith('reader-pagination-stage '),
          );
        if (!crossChapter) {
          expect(stage().props.style).toBeUndefined();
          await act(async () => {
            await props.apiRef.current?.scrollToSearchMatch?.(paragraph);
          });
        }
        expect(stage().props.style).toEqual({ marginTop: 240, height: 'calc(100% - 240px)' });
        expect(props.apiRef.current?.getAnchor()).toEqual(anchor);
        await act(async () => {
          await props.apiRef.current?.scrollToAnchor(anchor);
        });
        expect(stage().props.style).toBeUndefined();
        expect(props.apiRef.current?.getAnchor()).toEqual(anchor);
        expect(props.onPaginationFailure).not.toHaveBeenCalled();
      } finally {
        act(() => renderer?.unmount());
      }
    },
  );

  it('pauses layout and adjacent reads while hidden, then reuses the anchor on activation', async () => {
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.stubGlobal('window', { clearTimeout: vi.fn(), cancelAnimationFrame: vi.fn() });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { fonts: { ready: Promise.resolve() } }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const chapter = { id: 'active-pagination-fixture', novelId: 'book', index: 2, paragraphCount: 1, title: '본문' };
    const paragraph = { id: 'paragraph', novelId: 'book', chapterId: chapter.id, index: 1, text: '원문' };
    const anchor = {
      bookId: 'book',
      contentRevisionId: 'active-pagination-revision',
      sectionId: chapter.id,
      blockId: paragraph.id,
      blockIndex: 0,
      offset: 0,
    };
    const boundaries: ReaderPageBoundary[] = [{ index: 0, start: anchor, end: { ...anchor, offset: 2 } }];
    let resolveFirstMap!: (value?: StoredReaderPageMap) => void;
    vi.mocked(loadReaderPageMap).mockImplementationOnce(() => new Promise((resolve) => (resolveFirstMap = resolve)));
    vi.mocked(loadReaderPageMap).mockResolvedValue({
      id: 'stored-pagination-fixture',
      chapterId: chapter.id,
      contentRevisionId: anchor.contentRevisionId,
      layoutKey: 'fixture-layout',
      rendererVersion: 'fixture-renderer',
      boundaries,
      createdAt: '2026-09-05T00:00:00.000Z',
      lastAccessedAt: '2026-09-05T00:00:00.000Z',
    });
    const getParagraphPage = vi.fn(async () => ({ paragraphs: [paragraph] }));
    const apiRef: { current?: ReaderViewportApi } = {};
    const props = {
      novel: { id: 'book', activeContentRevisionId: anchor.contentRevisionId },
      chapter,
      chapters: [
        { ...chapter, id: 'previous-pagination-fixture', index: 1, paragraphCount: 60_000 },
        chapter,
        { ...chapter, id: 'next-pagination-fixture', index: 3, paragraphCount: 60_000 },
      ],
      repository: { getParagraphPage },
      settings: defaultSettings,
      mode: 'read',
      search: { highlightQuery: '' },
      screenHandle: new ReaderScreenHandle(),
      apiRef,
      onApiReady: vi.fn(),
      onVisualLocation: vi.fn(),
      onPaginationFailure: vi.fn(),
    } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
    let renderer!: ReactTestRenderer;
    const render = (isActive: boolean) => <PaginatedReaderViewport {...props} isActive={isActive} />;
    try {
      await act(async () => {
        renderer = create(render(false), {
          createNodeMock: () => ({ clientWidth: 800, clientHeight: 600, replaceChildren: vi.fn() }),
        });
      });
      expect(loadReaderPageMap).not.toHaveBeenCalled();
      expect(getParagraphPage).not.toHaveBeenCalled();

      await act(async () => renderer.update(render(true)));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(1);
      await act(async () => renderer.update(render(false)));
      await act(async () => resolveFirstMap(undefined));
      expect(getParagraphPage).not.toHaveBeenCalled();
      expect(props.onPaginationFailure).not.toHaveBeenCalled();

      await act(async () => renderer.update(render(true)));
      expect(apiRef.current?.getAnchor()).toEqual(anchor);
      expect(apiRef.current?.getLocation()).toMatchObject({ progress: 1, paragraphIndex: 1, offsetInParagraph: 0 });
      expect(getParagraphPage).toHaveBeenCalledTimes(1);
      const cancelledIdle = idleCallbacks.at(-1)!;
      await act(async () => renderer.update(render(false)));
      await act(async () => cancelledIdle());
      expect(getParagraphPage).toHaveBeenCalledTimes(1);

      await act(async () => renderer.update(render(true)));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(2);
      expect(apiRef.current?.getAnchor()).toEqual(anchor);
      await act(async () => idleCallbacks.at(-1)!());
      expect(getParagraphPage.mock.calls).toEqual([
        [chapter.id, 0],
        ['next-pagination-fixture', 0],
        ['previous-pagination-fixture', 499],
        ['previous-pagination-fixture', 498],
        ['next-pagination-fixture', 1],
      ]);
    } finally {
      act(() => renderer?.unmount());
    }
  });
});
