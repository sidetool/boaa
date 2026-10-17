import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark } from '../../domain/types';
import { buildAnnotationView } from '../../features/annotations/annotation-model';
import type { AnnotationsController } from '../../features/annotations/useAnnotationsController';
import { testChapter } from '../../features/book-workspace/book-workspace-test-fixtures';
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
    saveNoteDraft: vi.fn().mockResolvedValue(undefined),
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
