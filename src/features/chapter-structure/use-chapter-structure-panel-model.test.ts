import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChapterStructureController } from './useChapterStructureController';
import { useChapterStructurePanelModel, type ChapterStructurePanelModel } from './use-chapter-structure-panel-model';
function controller(overrides: Partial<ChapterStructureController> = {}): ChapterStructureController {
  const chapters = [
    {
      id: 'chapter_1',
      index: 1,
      title: '1화 시작',
      rawStartOffset: 0,
      rawEndOffset: 100,
      paragraphCount: 2,
      characterCount: 90,
      sourcePreview: '1화 시작\n\n첫 문단',
      splitCandidates: [
        {
          paragraphId: 'paragraph_2',
          paragraphIndex: 2,
          label: '2화 새로운 시작',
          sourceOffset: 50,
          headingFamily: 'numbered_hwa_jang',
          headingNumber: 2,
          headingTitle: '2화 새로운 시작',
        },
      ],
    },
    {
      id: 'chapter_2',
      index: 2,
      title: '2화 다음',
      rawStartOffset: 100,
      rawEndOffset: 200,
      paragraphCount: 1,
      characterCount: 80,
      sourcePreview: '2화 다음\n\n둘째 문단',
      splitCandidates: [],
    },
  ];
  return {
    open: true,
    busy: false,
    available: true,
    editor: {
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      sourceProvenance: 'original',
      chapters,
      reviewItemCount: 0,
    },
    openPanel: vi.fn(async () => undefined),
    closePanel: vi.fn(),
    previewCommands: vi.fn(async () => undefined),
    clearPreview: vi.fn(),
    applyPreview: vi.fn(async () => undefined),
    rollbackLatest: vi.fn(async () => undefined),
    ...overrides,
  };
}

it('filters chapters, keeps boundary drafts exclusive and produces preview commands', async () => {
  const input = controller();
  let model!: ChapterStructurePanelModel;
  function Harness() {
    model = useChapterStructurePanelModel(input);
    return null;
  }
  let app!: ReturnType<typeof create>;
  await act(async () => {
    app = create(createElement(Harness));
  });
  act(() => model.setQuery('2'));
  expect(model.filteredChapters.map((chapter) => chapter.id)).toEqual(['chapter_2']);
  act(() => model.toggleBoundaryRemoval('chapter_1'));
  expect(model.removedBoundaries.size).toBe(1);
  expect(model.draftCommands.length).toBeGreaterThan(0);
  act(() => model.toggleBoundaryAddition(input.editor!.chapters[0].splitCandidates[0]));
  expect(model.removedBoundaries.size).toBe(0);
  expect(model.addedBoundaries.size).toBe(1);
  act(() => model.setTitle(' Renamed '));
  act(() => model.previewRename());
  expect(input.previewCommands).toHaveBeenLastCalledWith([
    { kind: 'rename', chapterId: 'chapter_1', title: 'Renamed' },
  ]);
  expect(model.addedBoundaries.size).toBe(0);
  act(() => model.selectChapter('chapter_2'));
  expect(model.selected?.id).toBe('chapter_2');
  expect(model.title).toBe('2화 다음');
  expect(model.mobilePane).toBe('editor');
  act(() => model.previewReparse());
  expect(input.previewCommands).toHaveBeenLastCalledWith([
    { kind: 'reparse_range', startOffset: 100, splitMode: 'mixed' },
  ]);
  act(() => app.unmount());
});
