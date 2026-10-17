import { useEffect, useMemo, useState } from 'react';
import type { ChapterSplitMode } from '../../domain/types';
import {
  buildBoundaryAdditionCommands,
  buildBoundaryRemovalCommands,
  type BoundaryAdditionDraft,
} from './chapter-structure-view-model';
import type { ChapterStructureController } from './useChapterStructureController';
import type {
  ChapterSplitCandidate,
  ChapterStructureChapterView,
  ChapterStructureCommand,
} from '@boaa/text-core/chapter-structure';
const EMPTY_CHAPTERS: readonly ChapterStructureChapterView[] = [];

export function candidateKey(chapterId: string, sourceOffset: number): string {
  return `${chapterId}:${sourceOffset}`;
}

function candidateDraft(chapterId: string, candidate: ChapterSplitCandidate): BoundaryAdditionDraft {
  return {
    chapterId,
    sourceOffset: candidate.sourceOffset,
    title: candidate.headingTitle || candidate.label,
  };
}

export function useChapterStructurePanelModel(controller: ChapterStructureController) {
  const chapters = controller.editor?.chapters ?? EMPTY_CHAPTERS;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedId) ?? chapters[0],
    [chapters, selectedId],
  );
  const [query, setQuery] = useState('');
  const [mobilePane, setMobilePane] = useState<'list' | 'editor'>('list');
  const [showAllParagraphs, setShowAllParagraphs] = useState(false);
  const [removedBoundaries, setRemovedBoundaries] = useState<Set<string>>(() => new Set());
  const [addedBoundaries, setAddedBoundaries] = useState<Map<string, BoundaryAdditionDraft>>(() => new Map());
  const [focusedFamily, setFocusedFamily] = useState<string>();
  const [title, setTitle] = useState('');
  const [reparseMode, setReparseMode] = useState<ChapterSplitMode>('mixed');

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setTitle(selected.title);
    setShowAllParagraphs(false);
    setFocusedFamily(undefined);
  }, [selected]);

  useEffect(() => {
    setRemovedBoundaries(new Set());
    setAddedBoundaries(new Map());
  }, [controller.editor?.baseContentRevisionId]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredChapters = useMemo(() => {
    if (!normalizedQuery) return chapters;
    return chapters.filter(
      (chapter) =>
        chapter.title.toLocaleLowerCase().includes(normalizedQuery) || String(chapter.index) === normalizedQuery,
    );
  }, [chapters, normalizedQuery]);

  const headingCandidates = useMemo(
    () => selected?.splitCandidates.filter((candidate) => candidate.headingFamily) ?? [],
    [selected],
  );
  const visibleCandidates = showAllParagraphs ? (selected?.splitCandidates ?? []) : headingCandidates;
  const focusedFamilyCandidates = useMemo(
    () => headingCandidates.filter((candidate) => candidate.headingFamily === focusedFamily),
    [focusedFamily, headingCandidates],
  );
  const canRollback =
    controller.editor?.latestReceipt?.status === 'active' &&
    controller.editor.latestReceipt.contentRevisionId === controller.editor.baseContentRevisionId;

  const removalCommands = useMemo(
    () => buildBoundaryRemovalCommands(chapters, removedBoundaries),
    [chapters, removedBoundaries],
  );
  const additionCommands = useMemo(
    () => buildBoundaryAdditionCommands(chapters, [...addedBoundaries.values()]),
    [addedBoundaries, chapters],
  );
  const draftCommands = additionCommands.length > 0 ? additionCommands : removalCommands;

  const clearDraft = () => {
    setRemovedBoundaries(new Set());
    setAddedBoundaries(new Map());
    setFocusedFamily(undefined);
  };

  const previewCommands = (commands: readonly ChapterStructureCommand[]) => {
    if (commands.length === 0) return;
    void controller.previewCommands(commands);
  };

  const toggleBoundaryRemoval = (chapterId: string) => {
    setAddedBoundaries(new Map());
    setFocusedFamily(undefined);
    setRemovedBoundaries((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  const toggleBoundaryAddition = (candidate: ChapterSplitCandidate) => {
    if (!selected) return;
    setRemovedBoundaries(new Set());
    setFocusedFamily(candidate.headingFamily);
    setAddedBoundaries((current) => {
      const next = new Map(current);
      const key = candidateKey(selected.id, candidate.sourceOffset);
      if (next.has(key)) next.delete(key);
      else next.set(key, candidateDraft(selected.id, candidate));
      return next;
    });
  };

  const toggleFocusedFamily = () => {
    if (!selected || !focusedFamily || focusedFamilyCandidates.length === 0) return;
    setRemovedBoundaries(new Set());
    setAddedBoundaries((current) => {
      const next = new Map(current);
      const keys = focusedFamilyCandidates.map((candidate) => candidateKey(selected.id, candidate.sourceOffset));
      const allSelected = keys.every((key) => next.has(key));
      for (const candidate of focusedFamilyCandidates) {
        const key = candidateKey(selected.id, candidate.sourceOffset);
        if (allSelected) next.delete(key);
        else next.set(key, candidateDraft(selected.id, candidate));
      }
      return next;
    });
  };

  const selectChapter = (id: string) => {
    controller.clearPreview();
    setSelectedId(id);
    setMobilePane('editor');
  };
  const previewRename = () => {
    if (!selected) return;
    clearDraft();
    previewCommands([{ kind: 'rename', chapterId: selected.id, title: title.trim() }]);
  };
  const previewReparse = () => {
    if (!selected) return;
    clearDraft();
    previewCommands([{ kind: 'reparse_range', startOffset: selected.rawStartOffset, splitMode: reparseMode }]);
  };
  return {
    chapters,
    selectedId,
    selected,
    query,
    setQuery,
    normalizedQuery,
    filteredChapters,
    mobilePane,
    setMobilePane,
    showAllParagraphs,
    setShowAllParagraphs,
    removedBoundaries,
    addedBoundaries,
    focusedFamily,
    focusedFamilyCandidates,
    title,
    setTitle,
    reparseMode,
    setReparseMode,
    visibleCandidates,
    canRollback,
    removalCommands,
    additionCommands,
    draftCommands,
    clearDraft,
    previewCommands,
    toggleBoundaryRemoval,
    toggleBoundaryAddition,
    toggleFocusedFamily,
    selectChapter,
    previewRename,
    previewReparse,
  };
}
export type ChapterStructurePanelModel = ReturnType<typeof useChapterStructurePanelModel>;
