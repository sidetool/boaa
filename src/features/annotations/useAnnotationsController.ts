import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../../domain/types';
import { createAnnotationActions } from './annotation-controller-actions';
import type {
  AnnotationControllerOptions,
  AnnotationScope,
  AnnotationSort,
  AnnotationSelection,
  NoteAnchor,
} from './annotation-contract';
import { buildAnnotationView } from './annotation-model';
import { AnnotationPersistence } from './annotation-persistence';

export function useAnnotationsController(options: AnnotationControllerOptions) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<AnnotationScope>('all');
  const [sort, setSort] = useState<AnnotationSort>('recent');
  const [noteDraft, setDraftText] = useState('');
  const latestDraft = useRef('');
  const editorSession = useRef(0);
  const notePending = useRef<object>();
  const [noteBusy, setNoteBusy] = useState(false);
  const setNoteDraft = useCallback((text: string) => {
    latestDraft.current = text;
    setDraftText(text);
  }, []);
  const [editingNoteId, setEditingNoteId] = useState<string>();
  const [noteAnchor, setNoteAnchor] = useState<NoteAnchor>();
  const afterNavigation = useRef(options.onNavigated);
  afterNavigation.current = options.onNavigated;
  const book = useMemo(
    () => ({ id: options.novel?.id, repository: options.repository }),
    [options.novel?.id, options.repository],
  );
  const currentBook = useRef<typeof book>();
  useLayoutEffect(() => {
    currentBook.current = book;
    setNoteBusy(false);
    return () => {
      currentBook.current = undefined;
      notePending.current = undefined;
    };
  }, [book]);

  const resetEditor = useCallback(() => {
    editorSession.current++;
    setNoteDraft('');
    setEditingNoteId(undefined);
    setNoteAnchor(undefined);
  }, [setNoteDraft]);
  const editNote = useCallback(
    (note: ReaderNote) => {
      editorSession.current++;
      setEditingNoteId(note.id);
      setNoteAnchor(undefined);
      setNoteDraft(note.body);
    },
    [setNoteDraft],
  );

  useEffect(() => {
    setQuery('');
    setScope('all');
    setSort('recent');
  }, [book]);

  useLayoutEffect(() => resetEditor(), [book, options.chapter?.id, resetEditor]);

  const view = useMemo(
    () =>
      buildAnnotationView({
        collections: { bookmarks, highlights, notes },
        chapters: options.chapters,
        currentChapterId: options.chapter?.id,
        activeParagraphId: options.activeParagraphId,
        progress: options.readerProgress,
        query,
        scope,
        sort,
      }),
    [
      bookmarks,
      highlights,
      notes,
      options.activeParagraphId,
      options.chapter?.id,
      options.chapters,
      options.readerProgress,
      query,
      scope,
      sort,
    ],
  );
  const persistence = useMemo(() => new AnnotationPersistence(options.repository), [options.repository]);
  const actions = createAnnotationActions({
    ...options,
    onNavigated: () => afterNavigation.current?.(),
    persistence,
    bookmarks,
    highlights,
    notes,
    noteDraft,
    editingNoteId,
    scope,
    query,
    view,
    setBookmarks,
    setHighlights,
    setNotes,
    isNovelCurrent: (novelId) => currentBook.current === book && book.id === novelId,
  });

  const runNoteMutation = async (work: () => Promise<boolean>) => {
    if (currentBook.current !== book || notePending.current) return false;
    const token = {};
    notePending.current = token;
    setNoteBusy(true);
    try {
      return await work();
    } finally {
      if (notePending.current === token) {
        notePending.current = undefined;
        setNoteBusy(false);
      }
    }
  };

  return {
    bookmarks,
    highlights,
    notes,
    setBookmarks,
    setHighlights,
    setNotes,
    query,
    setQuery,
    scope,
    setScope,
    sort,
    setSort,
    noteDraft,
    setNoteDraft,
    editingNoteId,
    editNote,
    selectedQuote: noteAnchor?.selection.text,
    composeSelectionNote: (selection: AnnotationSelection) => {
      if (latestDraft.current.trim() || editingNoteId || notePending.current) {
        options.notify('먼저 작성 중인 메모를 저장하거나 취소해 주세요.', 'info');
        return;
      }
      editorSession.current++;
      const location = options.reader.getLocation();
      const paragraph = selection.paragraphId
        ? options.reader.getCachedParagraphById(selection.paragraphId)
        : undefined;
      setNoteAnchor({
        selection,
        location: location && {
          ...location,
          chapterId: paragraph?.chapterId ?? location.chapterId,
          paragraph: paragraph ?? location.paragraph,
        },
      });
    },
    resetEditor,
    view,
    ...actions,
    noteBusy,
    saveNoteDraft: () =>
      runNoteMutation(async () => {
        const session = editorSession.current;
        const savedId = await actions.saveNoteDraft(noteAnchor);
        if (!savedId || currentBook.current !== book || session !== editorSession.current) return false;
        if (latestDraft.current !== noteDraft) {
          setEditingNoteId(savedId);
          return false;
        }
        resetEditor();
        if (!editingNoteId) options.reader.clearSelection();
        return true;
      }),
    deleteNote: async (id: string) => {
      await runNoteMutation(async () => {
        const session = editorSession.current;
        const deleted = await actions.deleteNote(id);
        if (deleted && currentBook.current === book && session === editorSession.current && editingNoteId === id) {
          if (latestDraft.current === noteDraft) resetEditor();
          else setEditingNoteId(undefined);
        }
        return Boolean(deleted);
      });
    },
  };
}

export type AnnotationsController = ReturnType<typeof useAnnotationsController>;
