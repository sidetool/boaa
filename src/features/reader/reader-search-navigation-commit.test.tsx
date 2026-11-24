import { useSyncExternalStore } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Paragraph } from '../../domain/types';
import type { ReaderQueries } from '../../repositories/reader-repository';
import { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import {
  createBookWorkspaceTestHarness,
  testChapter,
  testNovel,
  testWorkspaceState,
} from '../book-workspace/book-workspace-test-fixtures';
import type { OpenReaderChapterOptions } from './reader-screen-contract';
import { useReaderSearch } from './use-reader-search';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(prepared: boolean) {
  const novel = testNovel({ format: 'txt' });
  const chapters = [1, 2, 3].map((index) => testChapter(index, { documentSectionId: `section-${index}` }));
  const h = createBookWorkspaceTestHarness({ novel, chapters });
  const loadingB = deferred<void>();
  const loadingC = deferred<void>();
  // Prepared source opens wait for the body; ordinary opens flush the previous position.
  // Neither navigation needs to wait for a voice-profile lookup.
  h.ports.transition.flushReaderSession = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => (prepared ? Promise.resolve() : loadingB.promise))
    .mockImplementationOnce(() => loadingC.promise);
  if (prepared)
    h.ports.adjacent.preloadReaderBody = (_novel, chapter) =>
      chapter.id === chapters[1].id ? loadingB.promise : undefined;
  const workspace = new BookWorkspaceController(
    h.ports,
    testWorkspaceState({
      view: 'reader',
      selectedNovel: novel,
      chapters,
      currentChapter: chapters[0],
    }),
  );
  const paragraphs = chapters.map((chapter): Paragraph => ({
    id: `paragraph-${chapter.id}`,
    novelId: novel.id,
    chapterId: chapter.id,
    index: 1,
    text: 'match',
    textHash: 'text',
    startOffsetInChapter: 0,
    endOffsetInChapter: 5,
  }));
  const repository = {
    searchParagraphPage: vi.fn(async () => ({ paragraphs, capped: false })),
  } as unknown as ReaderQueries;
  const scrollToMatch = vi.fn(async () => true);
  const notify = vi.fn();
  let search!: ReturnType<typeof useReaderSearch>;
  const openChapter = (chapter: (typeof chapters)[number], options: OpenReaderChapterOptions) =>
    prepared
      ? workspace.openDocumentSection(novel, chapter.documentSectionId!, undefined, chapters, options)
      : workspace.openChapter(chapter, options);
  function Probe() {
    const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
    search = useReaderSearch({
      repository,
      novel,
      chapter: state.currentChapter!,
      chapters,
      scrollToMatch,
      scrollToParagraph: async () => true,
      openChapter,
      notify,
    });
    return null;
  }
  return {
    h,
    workspace,
    paragraphs,
    chapters,
    loadingB,
    loadingC,
    scrollToMatch,
    Probe,
    search: () => search,
  };
}

describe.each([false, true])('search navigation commit (prepared source: %s)', (prepared) => {
  it.each(['same-chapter', 'clear', 'query', 'scope', 'unmount'] as const)(
    'prevents a late chapter B commit after %s',
    async (action) => {
      const t = setup(prepared);
      let renderer!: ReactTestRenderer;
      let opening!: Promise<void>;
      try {
        await act(async () => {
          renderer = create(<t.Probe />);
        });
        await act(async () => {
          opening = t.search().goToResult(t.paragraphs[1], 1);
        });
        expect(t.h.ports.transition.flushReaderSession).toHaveBeenCalledOnce();
        expect(t.workspace.getSnapshot().navigationPending).toBe(true);
        await act(async () => {
          if (action === 'same-chapter') await t.search().goToResult(t.paragraphs[0], 0);
          else if (action === 'clear') t.search().clear();
          else if (action === 'query') t.search().setQuery('different');
          else if (action === 'scope') t.search().setScope('book');
          else renderer.unmount();
        });
        expect(t.workspace.getSnapshot().navigationPending).toBe(false);
        await act(async () => {
          t.loadingB.resolve();
          await opening;
        });
        expect(t.workspace.getSnapshot().currentChapter?.id).toBe(t.chapters[0].id);
        expect(t.h.preparedOpens).toEqual([]);
        expect(t.h.calls).not.toContain(`transition.activateChapter:${t.chapters[1].id}`);
        if (action === 'same-chapter') {
          expect(t.scrollToMatch).toHaveBeenCalledWith(t.paragraphs[0]);
          expect(t.search().cursor).toBe(0);
        }
      } finally {
        act(() => renderer?.unmount());
      }
    },
  );

  it('does not cancel a newer ordinary chapter navigation when search closes', async () => {
    const t = setup(prepared);
    let renderer!: ReactTestRenderer;
    let searchOpen!: Promise<void>;
    let ordinaryOpen!: Promise<void>;
    try {
      await act(async () => {
        renderer = create(<t.Probe />);
      });
      await act(async () => {
        searchOpen = t.search().goToResult(t.paragraphs[1], 1);
      });
      await act(async () => {
        ordinaryOpen = t.workspace.openChapter(t.chapters[2]);
      });
      await act(async () => t.search().clear());
      expect(t.workspace.getSnapshot().navigationPending).toBe(true);
      await act(async () => {
        t.loadingB.resolve();
        await searchOpen;
      });
      expect(t.workspace.getSnapshot().navigationPending).toBe(true);
      await act(async () => {
        t.loadingC.resolve();
        await ordinaryOpen;
      });
      expect(t.workspace.getSnapshot().currentChapter?.id).toBe(t.chapters[2].id);
      expect(t.h.preparedOpens.map((open) => open.chapterId)).toEqual([t.chapters[2].id]);
      expect(t.workspace.getSnapshot().navigationPending).toBe(false);
    } finally {
      act(() => renderer?.unmount());
    }
  });
});
