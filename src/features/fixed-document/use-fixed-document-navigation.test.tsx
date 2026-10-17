import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { testChapter } from '../book-workspace/book-workspace-test-fixtures';
import { useFixedDocumentNavigation } from './use-fixed-document-navigation';

type Input = Parameters<typeof useFixedDocumentNavigation>[0];
const chapters = [1, 2, 3].map((index) => testChapter(index));
function harness(initial: Partial<Input> = {}) {
  let input: Input = { bookId: 'book', chapters, onNavigate: vi.fn(), ...initial };
  let controller!: ReturnType<typeof useFixedDocumentNavigation>;
  function Probe() {
    controller = useFixedDocumentNavigation(input);
    return null;
  }
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(<Probe />);
  });
  return {
    get controller() {
      return controller;
    },
    get onNavigate() {
      return vi.mocked(input.onNavigate);
    },
    update: (change: Partial<Input>) =>
      act(() => {
        input = { ...input, ...change };
        root.update(<Probe />);
      }),
    dispose: () => act(() => root.unmount()),
  };
}

it('restores a saved chapter once and preserves it when earlier chapters arrive', () => {
  const h = harness({ chapters: [chapters[1], chapters[2]], readingPosition: { chapterId: chapters[2].id } });
  try {
    expect(h.controller.pageIndex).toBe(1);
    h.update({ chapters });
    expect(h.controller.pageIndex).toBe(2);
    expect(h.controller.pageDraft).toBe('3');
    h.update({ readingPosition: { chapterId: chapters[0].id } });
    expect(h.controller.pageIndex).toBe(2);
  } finally {
    h.dispose();
  }
});

it('honors explicit entry versions without treating scrolling or appended chapters as another entry', () => {
  const h = harness({ initialChapterId: chapters[1].id });
  try {
    expect(h.controller.pageIndex).toBe(1);
    h.onNavigate.mockClear();
    act(() => h.controller.observePage(2));
    expect(h.controller.pageDraft).toBe('3');
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.update({ chapters: [...chapters, testChapter(4)] });
    expect(h.controller.pageIndex).toBe(2);
    h.update({ entryRequestVersion: 1 });
    expect(h.controller.pageIndex).toBe(1);
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    h.dispose();
  }
});

it('uses the newest viewport target and ignores invalid input while settling a changed book', () => {
  const h = harness();
  try {
    const navigate = vi.fn();
    h.update({ onNavigate: navigate });
    act(() => h.controller.goToPage(200));
    expect(h.controller.pageIndex).toBe(2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(2);
    act(() => h.controller.goToPage(Number.NaN));
    expect(navigate).toHaveBeenCalledOnce();
    h.update({ bookId: 'other', readingPosition: { chapterId: chapters[1].id } });
    expect(h.controller.pageIndex).toBe(1);
  } finally {
    h.dispose();
  }
});

it('follows fixed-text listening positions only for the active book', () => {
  const h = harness();
  const position = (bookId: string): NonNullable<Input['listeningPosition']> => ({
    anchor: {
      kind: 'fixed_text',
      bookId,
      pageIndex: 2,
      textRevisionId: 'text',
      blockId: 'block',
      startOffset: 0,
      endOffset: 1,
    },
  });
  try {
    h.update({ listeningPosition: position('other') });
    expect(h.controller.pageIndex).toBe(0);
    h.update({ listeningPosition: position('book') });
    expect(h.controller.pageIndex).toBe(2);
  } finally {
    h.dispose();
  }
});
