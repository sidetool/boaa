import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderOutlinePanelProps } from '../../features/annotations/reader-outline-contract';
import { testChapter } from '../../features/book-workspace/book-workspace-test-fixtures';
import UiNextOutlinePanel from './UiNextOutlinePanel';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function fixture(overrides: Partial<ReaderOutlinePanelProps> = {}): ReaderOutlinePanelProps {
  const chapters = [1, 2, 3, 4].map((index) => testChapter(index));
  return {
    chapters,
    filteredChapters: chapters,
    currentChapterId: 'chapter-2',
    readChapter: chapters[2],
    readChapterProgress: 0.4,
    annotationCounts: new Map(),
    query: '',
    setQuery: vi.fn(),
    openChapter: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function mount(props = fixture()) {
  const scrollIntoView = vi.fn();
  act(() => {
    renderer = create(<UiNextOutlinePanel {...props} />, {
      createNodeMock: (element) => (element.type === 'li' ? { scrollIntoView } : null),
    });
  });
  return { root: renderer!.root, props, scrollIntoView };
}
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function chapterButton(root: ReactTestInstance, title: string) {
  return root.find((node) => node.type === 'button' && node.findAllByType('b').some((child) => text(child) === title));
}

describe('UiNextOutlinePanel', () => {
  it('marks only the current chapter and scrolls it into view', () => {
    const { root, scrollIntoView } = mount();
    const current = chapterButton(root, '2화');
    expect(current.props['aria-current']).toBe('true');
    expect(root.findAllByProps({ 'aria-current': 'true' })).toHaveLength(1);
    expect(current.parent!.props.className.split(' ')).toContain('is-current');
    expect(current.parent!.props.className.split(' ')).not.toContain('is-read');
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
  });
  it('marks earlier chapters as read and leaves the saved and future chapters unmarked', () => {
    const { root } = mount();
    expect(chapterButton(root, '1화').parent!.props.className.split(' ')).toContain('is-read');
    for (const title of ['2화', '3화', '4화'])
      expect(chapterButton(root, title).parent!.props.className.split(' ')).not.toContain('is-read');
    expect(chapterButton(root, '1화').props['aria-current']).toBeUndefined();
  });
  it('does not mark chapters read without a saved chapter', () => {
    const { root } = mount(fixture({ readChapter: undefined }));
    expect(root.findAllByType('li').every((row) => !row.props.className.split(' ').includes('is-read'))).toBe(true);
  });
  it('forwards search input and renders only the supplied filtered chapters', () => {
    const props = fixture({ query: '3화' });
    const { root } = mount({ ...props, filteredChapters: [props.chapters[2]] });
    const input = root.findByProps({ 'aria-label': '화 목록 검색' });
    expect(input.props.value).toBe('3화');
    act(() => input.props.onChange({ target: { value: '4화' } }));
    expect(props.setQuery).toHaveBeenCalledExactlyOnceWith('4화');
    expect(root.findAllByType('button')).toHaveLength(1);
    expect(chapterButton(root, '3화')).toBeDefined();
  });
  it('shows an empty search result without chapter buttons', () => {
    const { root } = mount(fixture({ query: '없음', filteredChapters: [] }));
    expect(text(root)).toContain('검색 결과가 없어요.');
    expect(root.findAllByType('button')).toHaveLength(0);
  });
  it.each([1, 2, 3, 4])('opens chapter %s and restores only the saved chapter', (index) => {
    const { root, props } = mount();
    act(() => chapterButton(root, `${index}화`).props.onClick());
    expect(props.openChapter).toHaveBeenCalledExactlyOnceWith(props.chapters[index - 1], index === 3);
  });
  it.each([1, 2, 4])('marks pending chapter %s and shows saving guidance instead of its length', (index) => {
    const { root, props } = mount(fixture({ pendingChapterIds: new Set([`chapter-${index}`]) }));
    const pending = chapterButton(root, `${index}화`);
    expect(pending.parent!.props.className.split(' ')).toContain('is-pending');
    expect(text(pending)).toContain('열면 서재에 저장돼요');
    expect(text(pending)).not.toContain('100자');
    expect(pending.props['aria-current']).toBe(index === 2 ? 'true' : undefined);
    const saved = chapterButton(root, '3화');
    expect(saved.parent!.props.className.split(' ')).not.toContain('is-pending');
    expect(text(saved)).toContain('100자');
    expect(text(saved)).not.toContain('열면 서재에 저장돼요');
    act(() => pending.props.onClick());
    expect(props.openChapter).toHaveBeenCalledExactlyOnceWith(props.chapters[index - 1], false);
  });
  it('shows accessible annotation counts for a chapter', () => {
    const { root } = mount(
      fixture({ annotationCounts: new Map([['chapter-2', { bookmarks: 2, highlights: 3, notes: 1 }]]) }),
    );
    const current = chapterButton(root, '2화');
    for (const label of ['북마크 2개', '하이라이트 3개', '메모 1개'])
      expect(current.findByProps({ 'aria-label': label })).toBeDefined();
  });
});
