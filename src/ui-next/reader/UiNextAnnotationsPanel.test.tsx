import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { Bookmark, Paragraph, ReaderNote } from '../../domain/types';
import type { AnnotationRepository } from '../../features/annotations/annotation-contract';
import { buildAnnotationView } from '../../features/annotations/annotation-model';
import {
  useAnnotationsController,
  type AnnotationsController,
} from '../../features/annotations/useAnnotationsController';
import { testChapter, testNovel } from '../../features/book-workspace/book-workspace-test-fixtures';
import UiNextAnnotationsPanel from './UiNextAnnotationsPanel';

const bookmark: Bookmark = {
  id: 'bookmark-1',
  novelId: 'novel-1',
  chapterId: 'chapter-1',
  label: '현재 위치',
  progress: 0.2,
  scrollTop: 100,
  createdAt: '2026-07-01T00:00:00.000Z',
};
function controller(overrides: Partial<AnnotationsController> = {}): AnnotationsController {
  return {
    bookmarks: [],
    highlights: [],
    notes: [],
    setBookmarks: vi.fn(),
    setHighlights: vi.fn(),
    setNotes: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    scope: 'all',
    setScope: vi.fn(),
    sort: 'recent',
    setSort: vi.fn(),
    noteDraft: '',
    selectedQuote: undefined,
    composeSelectionNote: vi.fn(),
    noteBusy: false,
    setNoteDraft: vi.fn(),
    editingNoteId: undefined,
    editNote: vi.fn(),
    resetEditor: vi.fn(),
    view: buildAnnotationView({
      collections: { bookmarks: [], highlights: [], notes: [] },
      chapters: [testChapter(1)],
      currentChapterId: 'chapter-1',
      progress: 0.2,
      query: '',
      scope: 'all',
      sort: 'recent',
    }),
    toggleBookmark: vi.fn().mockResolvedValue(undefined),
    saveNoteDraft: vi.fn().mockResolvedValue(true),
    setHighlight: vi.fn().mockResolvedValue(undefined),
    deleteBookmark: vi.fn().mockResolvedValue(undefined),
    deleteHighlight: vi.fn().mockResolvedValue(undefined),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    goToBookmark: vi.fn(),
    goToHighlight: vi.fn(),
    goToNote: vi.fn(),
    copyMarkdown: vi.fn().mockResolvedValue(undefined),
    downloadMarkdown: vi.fn(),
    ...overrides,
  };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function mount(value = controller()) {
  act(() => {
    renderer = create(<UiNextAnnotationsPanel controller={value} />);
  });
  return { root: renderer!.root, controller: value };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const novel = testNovel();
const chapters = [testChapter(1)];
const paragraph: Paragraph = {
  id: 'paragraph-1',
  novelId: novel.id,
  chapterId: chapters[0].id,
  index: 0,
  text: '본문 문장',
  startOffsetInChapter: 0,
  endOffsetInChapter: 5,
  textHash: 'hash',
};

function note(id: string, body: string): ReaderNote {
  return {
    id,
    body,
    novelId: novel.id,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    progress: 0.25,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function noteRepository(initialNotes: ReaderNote[] = []) {
  const saved = new Map(initialNotes.map((item) => [item.id, item]));
  const repository = {
    getChapter: vi.fn(async () => chapters[0]),
    getParagraph: vi.fn(async () => paragraph),
    listBookmarks: vi.fn(async () => []),
    saveBookmark: vi.fn(async () => {}),
    deleteBookmark: vi.fn(async () => {}),
    listHighlights: vi.fn(async () => []),
    saveHighlight: vi.fn(async () => {}),
    deleteHighlight: vi.fn(async () => {}),
    listNotes: vi.fn(async () => [...saved.values()]),
    saveNote: vi.fn(async (item: ReaderNote) => {
      saved.set(item.id, item);
    }),
    deleteNote: vi.fn(async (id: string) => {
      saved.delete(id);
    }),
  } satisfies AnnotationRepository;
  return repository;
}

async function mountConnectedPanel(repository: AnnotationRepository) {
  const options = {
    novel,
    chapter: chapters[0],
    chapters,
    readerProgress: 0.25,
    reader: {
      getLocation: () => ({ progress: 0.25, scrollTop: 80, paragraphIndex: 0, paragraph }),
      getSelection: () => ({ text: '본문', paragraphId: paragraph.id }),
      getCachedParagraphById: () => paragraph,
      clearSelection: vi.fn(),
      scrollToParagraph: async () => true,
      scrubTo: async () => {},
    },
    openChapter: async () => {},
    onMutationCommitted: vi.fn(async () => {}),
    onPersistenceError: vi.fn(() => false),
    notify: vi.fn(),
  };
  function Panel({ repository }: { repository: AnnotationRepository }) {
    const controller = useAnnotationsController({ ...options, repository });
    const { setNotes } = controller;
    useEffect(() => {
      void repository.listNotes(novel.id).then(setNotes);
    }, [repository, setNotes]);
    return <UiNextAnnotationsPanel controller={controller} />;
  }
  await act(async () => {
    renderer = create(<Panel repository={repository} />);
  });
  return {
    root: renderer!.root,
    ...options,
    switchRepository: async (repository: AnnotationRepository) => {
      await act(async () => {
        renderer!.update(<Panel repository={repository} />);
      });
    },
  };
}

const noteDraft = (root: ReactTestInstance) => root.findByProps({ 'aria-label': '메모 내용' });
const writeNoteDraft = (root: ReactTestInstance, value: string) =>
  act(() => noteDraft(root).props.onChange({ target: { value } }));

async function submitNote(root: ReactTestInstance, times = 1) {
  const submit = root.findByType('form').props.onSubmit;
  await act(async () => {
    for (let attempt = 0; attempt < times; attempt++) submit({ preventDefault: vi.fn() });
  });
}

const savedNoteBodies = (root: ReactTestInstance) =>
  root.findAllByType('article').map((article) => text(article.findByType('p')));

describe('UiNextAnnotationsPanel quick actions and composer', () => {
  it.each([false, true])('shows the bookmarked=%s label and toggles the bookmark', async (bookmarked) => {
    const value = controller();
    const { root } = mount({ ...value, view: { ...value.view, activeBookmark: bookmarked ? bookmark : undefined } });
    const toggle = button(root, bookmarked ? '북마크됨' : '여기 북마크');
    expect(toggle.props['aria-pressed']).toBe(bookmarked);
    await click(toggle);
    expect(value.toggleBookmark).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['취소', '메모 쓰기'])('opens composing and resets the editor when closed with %s', async (closeLabel) => {
    const { root, controller: value } = mount();
    expect(button(root, '메모 쓰기').props['aria-expanded']).toBe(false);
    expect(root.findAllByType('textarea')).toHaveLength(0);
    await click(button(root, '메모 쓰기'));
    expect(button(root, '메모 쓰기').props['aria-expanded']).toBe(true);
    expect(button(root, '저장').props.disabled).toBe(true);
    act(() => root.findByProps({ 'aria-label': '메모 내용' }).props.onChange({ target: { value: '새 메모' } }));
    expect(value.setNoteDraft).toHaveBeenCalledExactlyOnceWith('새 메모');
    await click(button(root, closeLabel));
    expect(value.resetEditor).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });
  it('submits the note draft and closes composing after the controller clears it', async () => {
    const value = controller();
    const { root } = mount(value);
    await click(button(root, '메모 쓰기'));
    act(() => renderer!.update(<UiNextAnnotationsPanel controller={{ ...value, noteDraft: '새 메모' }} />));
    expect(button(root, '저장').props.disabled).toBe(false);
    const preventDefault = vi.fn();
    await act(async () => {
      root.findByType('form').props.onSubmit({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(value.saveNoteDraft).toHaveBeenCalledExactlyOnceWith();
    act(() => renderer!.update(<UiNextAnnotationsPanel controller={value} />));
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });
  it('opens an existing edited note and uses the edit-save action', async () => {
    const { root, controller: value } = mount(controller({ editingNoteId: 'note-1', noteDraft: '기존 메모' }));
    expect(button(root, '메모 쓰기').props['aria-expanded']).toBe(true);
    expect(root.findByProps({ 'aria-label': '메모 내용' }).props.value).toBe('기존 메모');
    expect(button(root, '수정 저장').props.disabled).toBe(false);
    await act(async () => {
      root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(value.saveNoteDraft).toHaveBeenCalledExactlyOnceWith();
  });
  it('disables saving a whitespace-only draft', () => {
    const { root } = mount(controller({ noteDraft: '   ' }));
    expect(button(root, '저장').props.disabled).toBe(true);
  });
});

describe('UiNextAnnotationsPanel note persistence', () => {
  it('opens the editor and saves the original quote after the browser selection changes', async () => {
    const repository = noteRepository();
    const { root } = await mountConnectedPanel(repository);
    const value: AnnotationsController = root.findByType(UiNextAnnotationsPanel).props.controller;
    act(() => value.composeSelectionNote({ paragraphId: paragraph.id, text: '선택했던 문장' }));
    expect(text(root.findByType('blockquote'))).toBe('선택했던 문장');
    writeNoteDraft(root, '나중에 확인');
    await submitNote(root);
    expect(repository.saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ quote: '선택했던 문장', paragraphId: paragraph.id }),
      expect.anything(),
    );
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });
  it('saves once when the form is submitted twice before the first request finishes', async () => {
    const repository = noteRepository();
    const pendingSave = deferred<void>();
    const save = repository.saveNote.getMockImplementation()!;
    repository.saveNote.mockImplementation(async (item) => {
      await pendingSave.promise;
      await save(item);
    });
    const { root } = await mountConnectedPanel(repository);
    await click(button(root, '메모 쓰기'));
    writeNoteDraft(root, '새 메모');
    await submitNote(root, 2);
    expect(repository.saveNote).toHaveBeenCalledTimes(1);
    await act(async () => pendingSave.resolve());

    expect(savedNoteBodies(root)).toEqual(['새 메모']);
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });

  it('keeps the newer draft and updates the same note after a create finishes', async () => {
    const repository = noteRepository();
    const pendingSave = deferred<void>();
    const save = repository.saveNote.getMockImplementation()!;
    repository.saveNote.mockImplementationOnce(async (item) => {
      await pendingSave.promise;
      await save(item);
    });
    const { root } = await mountConnectedPanel(repository);
    await click(button(root, '메모 쓰기'));
    writeNoteDraft(root, '먼저 보낸 메모');
    await submitNote(root);
    writeNoteDraft(root, '입력 중인 수정');
    await act(async () => pendingSave.resolve());

    expect(savedNoteBodies(root)).toEqual(['먼저 보낸 메모']);
    expect(noteDraft(root).props.value).toBe('입력 중인 수정');
    await submitNote(root);
    expect(savedNoteBodies(root)).toEqual(['입력 중인 수정']);
    expect(repository.saveNote.mock.calls[1][0].id).toBe(repository.saveNote.mock.calls[0][0].id);
  });

  it('keeps a failed draft available for retry', async () => {
    const repository = noteRepository();
    repository.saveNote.mockRejectedValueOnce(new Error('offline'));
    const { root, notify } = await mountConnectedPanel(repository);
    await click(button(root, '메모 쓰기'));
    writeNoteDraft(root, '다시 저장할 메모');
    await submitNote(root);

    expect(notify).toHaveBeenCalledWith('메모를 저장하지 못했습니다.', 'danger');
    expect(noteDraft(root).props.value).toBe('다시 저장할 메모');
    await submitNote(root);
    expect(savedNoteBodies(root)).toEqual(['다시 저장할 메모']);
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });

  it('shows the saved note when the follow-up list fails', async () => {
    const repository = noteRepository();
    const { root } = await mountConnectedPanel(repository);
    repository.listNotes.mockRejectedValueOnce(new Error('offline'));
    await click(button(root, '메모 쓰기'));
    writeNoteDraft(root, '이미 저장된 메모');
    await submitNote(root);

    expect(repository.saveNote).toHaveBeenCalledTimes(1);
    expect(savedNoteBodies(root)).toEqual(['이미 저장된 메모']);
    expect(root.findAllByType('textarea')).toHaveLength(0);
  });

  it.each(['success', 'failure'])('ignores an old account save %s for the same book', async (result) => {
    const oldRepository = noteRepository();
    const newRepository = noteRepository([note('current', '현재 계정 메모')]);
    const pendingSave = deferred<void>();
    const save = oldRepository.saveNote.getMockImplementation()!;
    oldRepository.saveNote.mockImplementation(async (item) => {
      await pendingSave.promise;
      await save(item);
    });
    const { root, switchRepository, notify, reader, onPersistenceError } = await mountConnectedPanel(oldRepository);
    await click(button(root, '메모 쓰기'));
    writeNoteDraft(root, '이전 계정 메모');
    await submitNote(root);
    await switchRepository(newRepository);
    await click(button(root, '수정'));
    writeNoteDraft(root, '현재 계정에서 작성 중');
    await act(async () => {
      if (result === 'success') pendingSave.resolve();
      else pendingSave.reject(new Error('old account failure'));
    });

    expect(savedNoteBodies(root)).toEqual(['현재 계정 메모']);
    expect(noteDraft(root).props.value).toBe('현재 계정에서 작성 중');
    expect(notify).not.toHaveBeenCalled();
    expect(reader.clearSelection).not.toHaveBeenCalled();
    expect(onPersistenceError).not.toHaveBeenCalled();
    await submitNote(root);
    expect(savedNoteBodies(root)).toEqual(['현재 계정에서 작성 중']);
  });

  it('waits for the save refresh before allowing deletion', async () => {
    const repository = noteRepository([note('existing', '수정할 메모')]);
    const { root } = await mountConnectedPanel(repository);
    const pendingList = deferred<ReaderNote[]>();
    repository.listNotes.mockImplementationOnce(() => pendingList.promise);
    await click(button(root, '수정'));
    writeNoteDraft(root, '저장한 수정');
    await submitNote(root);

    const deleteButton = button(root, '삭제');
    expect(deleteButton.props.disabled).toBe(true);
    await act(async () => deleteButton.props.onClick());
    expect(repository.deleteNote).not.toHaveBeenCalled();
    const savedRows = await repository.listNotes();
    await act(async () => pendingList.resolve(savedRows));
    expect(savedNoteBodies(root)).toEqual(['저장한 수정']);
    await click(button(root, '삭제'));
    expect(repository.deleteNote).toHaveBeenCalledWith('existing', expect.anything());
    expect(savedNoteBodies(root)).toEqual([]);
  });

  it('removes a committed deletion from the list when the refresh fails', async () => {
    const repository = noteRepository([note('existing', '기존 메모')]);
    const { root, notify } = await mountConnectedPanel(repository);
    repository.listNotes.mockRejectedValueOnce(new Error('offline'));
    await click(button(root, '삭제'));
    expect(savedNoteBodies(root)).toEqual([]);
    expect(repository.deleteNote).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalledWith('메모를 삭제하지 못했습니다.', 'danger');
  });

  it('keeps unsaved edits if deleting the edited note fails', async () => {
    const repository = noteRepository([note('existing', '기존 메모')]);
    repository.deleteNote.mockRejectedValueOnce(new Error('offline'));
    const { root, notify } = await mountConnectedPanel(repository);
    await click(button(root, '수정'));
    writeNoteDraft(root, '아직 저장하지 않은 수정');
    await click(button(root, '삭제'));

    expect(notify).toHaveBeenCalledWith('메모를 삭제하지 못했습니다.', 'danger');
    expect(noteDraft(root).props.value).toBe('아직 저장하지 않은 수정');
    expect(savedNoteBodies(root)).toEqual(['기존 메모']);
    await submitNote(root);
    expect(savedNoteBodies(root)).toEqual(['아직 저장하지 않은 수정']);
  });
});

describe('UiNextAnnotationsPanel filters and export', () => {
  it.each(['all', 'chapter'] as const)('toggles chapter scope from %s', async (scope) => {
    const { root, controller: value } = mount(controller({ scope }));
    const chip = button(root, '이 화만');
    expect(chip.props['aria-pressed']).toBe(scope === 'chapter');
    await click(chip);
    expect(value.setScope).toHaveBeenCalledExactlyOnceWith(scope === 'chapter' ? 'all' : 'chapter');
  });
  it.each(['recent', 'position'] as const)('toggles position sort from %s', async (sort) => {
    const { root, controller: value } = mount(controller({ sort }));
    const chip = button(root, '본문 순서로');
    expect(chip.props['aria-pressed']).toBe(sort === 'position');
    await click(chip);
    expect(value.setSort).toHaveBeenCalledExactlyOnceWith(sort === 'position' ? 'recent' : 'position');
  });
  it('forwards annotation search input', () => {
    const { root, controller: value } = mount(controller({ query: '기존 검색어' }));
    const input = root.findByProps({ 'aria-label': '주석 검색' });
    expect(input.props.value).toBe('기존 검색어');
    act(() => input.props.onChange({ target: { value: '새 검색어' } }));
    expect(value.setQuery).toHaveBeenCalledExactlyOnceWith('새 검색어');
  });
  it.each([
    ['Markdown 복사', 'copyMarkdown'],
    ['파일로 저장', 'downloadMarkdown'],
  ] as const)('exports with %s', async (label, action) => {
    const { root, controller: value } = mount();
    await click(button(root, label));
    expect(value[action]).toHaveBeenCalledExactlyOnceWith();
  });
});
