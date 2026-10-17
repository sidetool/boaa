import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChaptersScreenProps } from '../../features/chapters/chapters-screen-contract';
import { buildChapterListModel } from '../../features/chapters/chapters-screen-model';
import { testChapter } from '../../features/book-workspace/book-workspace-test-fixtures';
import { buildLibraryBookView } from '../../features/library/library-screen-model';
import { rememberNavigationViewState } from '../../features/navigation/navigation-view-state';
import { novel } from '../test-fixtures';
import { UiNextChaptersScreen } from './UiNextChaptersScreen';

// Render the real sheets inline in the Node renderer; preserve their actions/effects.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('document', {
    activeElement: null,
    documentElement: { style: { overflow: '' } },
    body: {},
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  rememberNavigationViewState('ui-next-chapters:novel-1:page', 1);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function button(root: ReactTestInstance, name: string | RegExp): ReactTestInstance {
  return root.find((node) => {
    if (node.type !== 'button') return false;
    const label: string = node.props['aria-label'] ?? text(node).replace(/\s+/g, ' ').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
}

function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

async function clickAsync(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}

function fixture(count = 3, currentIndex = 2): ChaptersScreenProps {
  const chapters = Array.from({ length: count }, (_, i) =>
    testChapter(i + 1, {
      novelId: 'novel-1',
      title: `${i + 1}화 제목`,
      documentSectionReadAt: i === 0 ? '2026-07-01T00:00:00.000Z' : undefined,
    }),
  );
  const source = novel({
    format: 'txt',
    sourceFileName: 'chapters.txt',
    sourceAssetId: 'source-1',
    author: '테스트 작가',
    totalChapters: count,
    totalCharacters: count * 1200,
    totalParagraphs: count * 20,
    lastReadChapterId: `chapter-${currentIndex}`,
    lastReadChapterIndex: currentIndex,
    lastReadProgress: 0.6,
    readingSeconds: 600,
  });
  const currentChapter = chapters.find((chapter) => chapter.index === currentIndex);
  return {
    model: {
      book: buildLibraryBookView(source, { hasReadActivity: () => true, isFinished: () => false }),
      titleEditor: { editing: false, draft: source.title },
      query: '',
      readFilter: 'all',
      sort: 'asc',
      chapterList: buildChapterListModel({
        chapters,
        query: '',
        readFilter: 'all',
        sort: 'asc',
        currentChapter,
        annotationCounts: new Map(),
      }),
      summary: {
        readChapterProgress: 0.2,
        readLocationLabel: `${currentIndex}. ${currentIndex}화 제목`,
        bookmarkCount: 1,
        highlightCount: 2,
        noteCount: 3,
        syncLabel: '로컬',
        firstUnreadChapter: chapters.find((chapter) => !chapter.documentSectionReadAt),
        currentReadTargetChapter: currentChapter,
        canMarkCurrentChapterRead: true,
        canMarkBookFinished: true,
        canResetBookProgress: true,
      },
    },
    actions: {
      navigation: {
        backToLibrary: vi.fn(),
        continueReading: vi.fn(),
        openSettings: vi.fn(),
        openSync: vi.fn(),
        openImport: vi.fn(),
        openChapterAppend: vi.fn(),
        openStructureEditor: vi.fn(),
        openMetadata: vi.fn(),
      },
      titleEditor: { start: vi.fn(), cancel: vi.fn(), setDraft: vi.fn(), save: vi.fn() },
      book: {
        toggleFavorite: vi.fn(),
        openFirstUnreadChapter: vi.fn(),
        markCurrentChapterRead: vi.fn(),
        markFinished: vi.fn(),
        resetProgress: vi.fn(),
        exportSource: vi.fn(),
        reselectSource: vi.fn(),
        reconstructSource: vi.fn(),
      },
      chapterList: {
        setQuery: vi.fn(),
        setReadFilter: vi.fn(),
        setSort: vi.fn(),
        openChapter: vi.fn(),
        markRead: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

function mount(props = fixture()) {
  const fileInput = { click: vi.fn() };
  act(() => {
    renderer = create(<UiNextChaptersScreen {...props} />, {
      // Only file selection needs a native ref; layout/scroll refs stay null.
      createNodeMock: (element) => (element.type === 'input' && element.props.type === 'file' ? fileInput : null),
    });
  });
  return { root: renderer!.root, props, fileInput };
}

function more(root: ReactTestInstance, props: ChaptersScreenProps) {
  click(button(root, '더보기'));
  return root.findByProps({ role: 'dialog', 'aria-label': props.model.book.novel.title });
}

function chapterMenu(root: ReactTestInstance, title = '2화 제목') {
  click(button(root, `${title} 작업`));
  return root.findByProps({ role: 'dialog' });
}

function chapterButtons(root: ReactTestInstance) {
  return root.findAllByType('button').filter((node) => /^\d+화, /.test(node.props['aria-label'] ?? ''));
}

describe('detail hero controls', () => {
  it.each([
    [true, true, '첫 화 보기'],
    [false, true, '2화 이어 읽기'],
    [false, false, '이어 읽기'],
  ] as const)('labels resume for unread=%s, current target=%s as %s', (unread, hasTarget, label) => {
    const props = fixture();
    props.model.book.isUnread = unread;
    if (!hasTarget) props.model.summary.currentReadTargetChapter = undefined;
    const { root } = mount(props);
    click(button(root, label));
    expect(props.actions.navigation.continueReading).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, true])('exposes favorite=%s and passes the novel to toggleFavorite', (favorite) => {
    const props = fixture();
    props.model.book.novel.favorite = favorite;
    const { root } = mount(props);
    const toggle = button(root, '즐겨찾기');
    expect(toggle.props['aria-pressed']).toBe(favorite);
    click(toggle);
    expect(props.actions.book.toggleFavorite).toHaveBeenCalledExactlyOnceWith(props.model.book.novel);
  });

  it.each([
    ['txt', true],
    ['markdown', true],
    ['epub', true],
    ['pdf', false],
    ['image_archive', false],
    [undefined, false],
  ] as const)('offers append only for supported formats (%s)', (format, canAppend) => {
    const props = fixture();
    props.model.book.novel.format = format;
    const { root } = mount(props);
    click(button(root, '작품 정보 편집'));
    expect(props.actions.navigation.openMetadata).toHaveBeenCalledExactlyOnceWith();
    expect(props.actions.navigation.openChapterAppend).not.toHaveBeenCalled();
    expect(root.findAllByProps({ 'aria-label': '회차 추가' })).toHaveLength(0);
    const sheet = more(root, props);
    const append = sheet.findAllByType('button').filter((node) => text(node) === '회차 추가');
    expect(append).toHaveLength(canAppend ? 1 : 0);
    if (format === 'epub') expect(text(sheet)).not.toContain('회차 나누기 편집');
    if (canAppend) {
      click(append[0]);
      expect(props.actions.navigation.openChapterAppend).toHaveBeenCalledExactlyOnceWith();
      expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    }
  });
});

describe('detail more sheet', () => {
  it.each([
    ['회차 나누기 편집', 'openStructureEditor'],
    ['회차 추가', 'openChapterAppend'],
    ['읽기 설정', 'openSettings'],
    ['동기화 상세', 'openSync'],
  ] as const)('routes %s to navigation.%s and closes the sheet', (label, action) => {
    const { root, props } = mount();
    click(button(more(root, props), label));
    expect(props.actions.navigation[action]).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each([
    ['첫 안 읽은 화 열기', 'openFirstUnreadChapter'],
    ['지금 회차 읽음으로', 'markCurrentChapterRead'],
    ['완독으로 표시', 'markFinished'],
    ['읽은 기록 지우기', 'resetProgress'],
    ['원본 내려받기', 'exportSource'],
  ] as const)('routes %s to book.%s', (label, action) => {
    const { root, props } = mount();
    click(button(more(root, props), label));
    expect(props.actions.book[action]).toHaveBeenCalledExactlyOnceWith(
      ...(action === 'exportSource' ? [props.model.book.novel] : []),
    );
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each([false, true])('routes the quick-title action when editing=%s', (editing) => {
    const props = fixture();
    props.model.titleEditor.editing = editing;
    const { root } = mount(props);
    click(button(more(root, props), editing ? '제목 수정 취소' : '제목 빠르게 고치기'));
    expect(props.actions.titleEditor[editing ? 'cancel' : 'start']).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ['첫 안 읽은 화 열기', { firstUnreadChapter: undefined }],
    ['지금 회차 읽음으로', { canMarkCurrentChapterRead: false }],
    ['완독으로 표시', { canMarkBookFinished: false }],
    ['읽은 기록 지우기', { canResetBookProgress: false }],
  ] satisfies [string, Partial<ChaptersScreenProps['model']['summary']>][])(
    'disables %s when the summary disallows it',
    (label, patch) => {
      const props = fixture();
      Object.assign(props.model.summary, patch);
      const { root } = mount(props);
      expect(button(more(root, props), label).props.disabled).toBe(true);
    },
  );

  it('disables source download and offers reconstruction when there is no source asset', () => {
    const props = fixture();
    props.model.book.novel.sourceAssetId = undefined;
    const { root } = mount(props);
    const sheet = more(root, props);
    expect(button(sheet, '원본 내려받기').props.disabled).toBe(true);
    click(button(sheet, '재구성본 만들기'));
    expect(props.actions.book.reconstructSource).toHaveBeenCalledExactlyOnceWith(props.model.book.novel);
    expect(props.actions.book.exportSource).not.toHaveBeenCalled();
  });

  it('omits reconstruction while the original source asset is available', () => {
    const { root, props } = mount();
    const sheet = more(root, props);
    expect(button(sheet, '원본 내려받기').props.disabled).toBe(false);
    expect(text(sheet)).not.toContain('재구성본 만들기');
  });

  it('opens the source picker and passes the selected file to reselectSource', () => {
    const { root, props, fileInput } = mount();
    click(button(more(root, props), '원본 다시 고르기'));
    expect(fileInput.click).toHaveBeenCalledExactlyOnceWith();
    const file = new File(['본문'], 'replacement.txt', { type: 'text/plain' });
    const target = { files: [file], value: 'replacement.txt' };
    act(() => root.findByProps({ 'aria-label': '원본 파일 선택' }).props.onChange({ target }));
    expect(props.actions.book.reselectSource).toHaveBeenCalledExactlyOnceWith(props.model.book.novel, file);
    expect(target.value).toBe('');
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});

describe('book title editor', () => {
  it('shows the draft, sends input changes, and cancels on Escape', () => {
    const props = fixture();
    props.model.titleEditor = { editing: true, draft: '수정 중인 제목' };
    const { root } = mount(props);
    const input = root.findByProps({ 'aria-label': '책 제목' });
    expect(input.props.value).toBe('수정 중인 제목');
    act(() => input.props.onChange({ target: { value: '새 책 제목' } }));
    expect(props.actions.titleEditor.setDraft).toHaveBeenCalledExactlyOnceWith('새 책 제목');
    const preventDefault = vi.fn();
    act(() => input.props.onKeyDown({ key: 'Escape', preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(props.actions.titleEditor.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(props.actions.titleEditor.save).not.toHaveBeenCalled();
  });

  it('saves through the title form submit button', () => {
    const props = fixture();
    props.model.titleEditor.editing = true;
    const { root } = mount(props);
    expect(button(root, '책 제목 저장').props.type).toBe('submit');
    const preventDefault = vi.fn();
    act(() => root.findByType('form').props.onSubmit({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(props.actions.titleEditor.save).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('chapter tab', () => {
  it('opens chapter rows with the current-row restore flag and exposes aria-current', () => {
    const { root, props } = mount();
    const rows = chapterButtons(root);
    expect(rows).toHaveLength(3);
    expect(rows[0].props['aria-current']).toBeUndefined();
    expect(rows[1].props['aria-current']).toBe('location');
    expect(rows[2].props['aria-current']).toBeUndefined();
    for (const [index, row] of rows.entries()) {
      click(row);
      expect(props.actions.chapterList.openChapter).toHaveBeenNthCalledWith(
        index + 1,
        props.model.chapterList.rows[index].chapter,
        index === 1,
      );
    }
  });

  it('routes search input to setQuery', () => {
    const { root, props } = mount();
    const search = root.findByProps({ 'aria-label': '화 검색' });
    expect(search.props.type).toBe('search');
    act(() => search.props.onChange({ target: { value: '12화' } }));
    expect(props.actions.chapterList.setQuery).toHaveBeenCalledExactlyOnceWith('12화');
  });

  it.each([
    ['전체', 'all'],
    ['안 읽음', 'unread'],
    ['읽음', 'read'],
  ] as const)('routes the %s filter to setReadFilter(%s)', (label, filter) => {
    const { root, props } = mount();
    const group = root.findByProps({ role: 'radiogroup', 'aria-label': '읽은 상태 필터' });
    const option = button(group, label);
    expect(option.props.role).toBe('radio');
    expect(option.props['aria-checked']).toBe(filter === 'all');
    click(option);
    expect(props.actions.chapterList.setReadFilter).toHaveBeenCalledExactlyOnceWith(filter);
  });

  it.each([
    ['asc', 'desc', '처음 화부터'],
    ['desc', 'asc', '최신 화부터'],
  ] as const)('toggles sorting from %s to %s', (sort, next, label) => {
    const props = fixture();
    props.model.sort = sort;
    const { root } = mount(props);
    click(button(root, `정렬: ${label}`));
    expect(props.actions.chapterList.setSort).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('starts on the current chapter’s 30-row page and responds to numeric/previous/next buttons', () => {
    const { root, props } = mount(fixture(65, 35));
    const pager = root.findByProps({ 'aria-label': '회차 페이지' });
    const indices = () => chapterButtons(root).map((node) => Number(node.props['aria-label'].split('화')[0]));
    expect(indices()).toEqual(Array.from({ length: 30 }, (_, i) => i + 31));
    expect(button(pager, '2페이지').props['aria-current']).toBe('page');
    click(button(pager, '이전 페이지'));
    expect(indices()).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(button(pager, '이전 페이지').props.disabled).toBe(true);
    click(button(pager, '3페이지'));
    expect(indices()).toEqual([61, 62, 63, 64, 65]);
    expect(button(pager, '3페이지').props['aria-current']).toBe('page');
    expect(button(pager, '다음 페이지').props.disabled).toBe(true);
    click(button(pager, '이전 페이지'));
    click(button(pager, '다음 페이지'));
    expect(indices()).toEqual([61, 62, 63, 64, 65]);
    expect(props.actions.chapterList.openChapter).not.toHaveBeenCalled();
  });

  it('does not render page controls for exactly 30 chapters', () => {
    const { root } = mount(fixture(30));
    expect(chapterButtons(root)).toHaveLength(30);
    expect(root.findAllByProps({ 'aria-label': '회차 페이지' })).toHaveLength(0);
  });

  it.each([
    ['없는 제목', 'all'],
    ['', 'unread'],
  ] as const)('offers to clear an empty result with query=%s, filter=%s', (query, readFilter) => {
    const props = fixture(0);
    props.model.query = query;
    props.model.readFilter = readFilter;
    const { root } = mount(props);
    expect(text(root)).toContain('맞는 회차가 없어요');
    click(button(root, '검색과 필터 지우기'));
    expect(props.actions.chapterList.setQuery).toHaveBeenCalledExactlyOnceWith('');
    expect(props.actions.chapterList.setReadFilter).toHaveBeenCalledExactlyOnceWith('all');
  });

  it('shows the unfiltered empty state without a clear button', () => {
    const { root } = mount(fixture(0));
    expect(text(root)).toContain('회차가 없어요');
    expect(root.findAllByType('button').map(text)).not.toContain('검색과 필터 지우기');
  });
});

describe('chapter action sheet', () => {
  it.each([
    ['읽음으로 표시', false],
    ['여기까지 모두 읽음', true],
  ] as const)('routes %s to markRead with previous=%s', async (label, previous) => {
    const { root, props } = mount();
    const chapter = props.model.chapterList.rows[1].chapter;
    await clickAsync(button(chapterMenu(root), label));
    expect(props.actions.chapterList.markRead).toHaveBeenCalledExactlyOnceWith(chapter, previous);
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('disables marking an already read chapter individually while allowing 여기까지 모두 읽음', () => {
    const { root } = mount();
    const sheet = chapterMenu(root, '1화 제목');
    expect(button(sheet, '이미 읽은 회차예요').props.disabled).toBe(true);
    expect(button(sheet, '여기까지 모두 읽음').props.disabled).toBe(false);
  });

  it('edits the chapter title and sends the draft to rename', async () => {
    const { root, props } = mount();
    const chapter = props.model.chapterList.rows[1].chapter;
    click(button(chapterMenu(root), '제목 수정'));
    const sheet = root.findByProps({ role: 'dialog', 'aria-label': '회차 제목 수정' });
    const input = sheet.findByProps({ 'aria-label': '회차 제목' });
    expect(input.props.value).toBe(chapter.title);
    act(() => input.props.onChange({ target: { value: '새 회차 제목' } }));
    expect(button(sheet, '저장').props.type).toBe('submit');
    await act(async () => {
      sheet.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(props.actions.chapterList.rename).toHaveBeenCalledExactlyOnceWith(chapter, '새 회차 제목');
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each(['markRead', 'rename'] as const)('keeps the sheet open with an alert when %s fails', async (action) => {
    const props = fixture();
    props.actions.chapterList[action] = vi.fn().mockRejectedValue(new Error('저장에 실패했습니다'));
    const { root } = mount(props);
    const sheet = chapterMenu(root);
    if (action === 'markRead') {
      await clickAsync(button(sheet, '읽음으로 표시'));
    } else {
      click(button(sheet, '제목 수정'));
      await act(async () => {
        root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      });
    }
    expect(props.actions.chapterList[action]).toHaveBeenCalledOnce();
    expect(text(root.findByProps({ role: 'alert' }))).toBe('저장에 실패했습니다');
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
  });

  it('does not offer a chapter menu without markRead or rename', () => {
    const props = fixture();
    props.actions.chapterList.markRead = undefined;
    props.actions.chapterList.rename = undefined;
    const { root } = mount(props);
    expect(root.findAllByType('button').filter((node) => / 작업$/.test(node.props['aria-label'] ?? ''))).toHaveLength(
      0,
    );
    expect(chapterButtons(root)).toHaveLength(3);
  });

  it.each(['markRead', 'rename'] as const)(
    'keeps the menu with only %s and disables unsupported actions',
    (available) => {
      const props = fixture();
      props.actions.chapterList[available === 'markRead' ? 'rename' : 'markRead'] = undefined;
      const { root } = mount(props);
      const sheet = chapterMenu(root);
      expect(button(sheet, '읽음으로 표시').props.disabled).toBe(available !== 'markRead');
      expect(button(sheet, '여기까지 모두 읽음').props.disabled).toBe(available !== 'markRead');
      expect(button(sheet, '제목 수정').props.disabled).toBe(available !== 'rename');
    },
  );
});

describe('information tab and loading state', () => {
  it('switches to information facts and back to the chapter list', () => {
    const { root } = mount();
    expect(root.findAllByType('dl')).toHaveLength(0);
    const tabs = root.findByProps({ role: 'tablist', 'aria-label': '작품 상세' });
    click(button(tabs, '정보'));
    expect(button(tabs, '정보').props['aria-selected']).toBe(true);
    const facts = Object.fromEntries(
      root
        .findByType('dl')
        .findAllByType('div')
        .map((entry) => [text(entry.findByType('dt')), text(entry.findByType('dd'))]),
    );
    expect(facts).toMatchObject({
      형식: 'TXT',
      '총 회차': '3화',
      분량: '3,600자 · 60문단',
      진행률: '60%',
      '현재 위치': '2. 2화 제목',
      '누적 독서 시간': '10분 0초',
      북마크: '1개',
      하이라이트: '2개',
      메모: '3개',
      동기화: '로컬',
      'AI 애드온': '꺼짐',
      '원본 파일': 'chapters.txt',
      인코딩: 'UTF-8',
    });
    expect(chapterButtons(root)).toHaveLength(0);
    click(button(tabs, /^회차\d+$/));
    expect(chapterButtons(root)).toHaveLength(3);
    expect(root.findAllByType('dl')).toHaveLength(0);
  });

  it('renders a loading status with hidden skeleton rows instead of stale chapter rows', () => {
    const props = fixture();
    props.model.loading = true;
    const { root } = mount(props);
    const status = root.findByProps({ role: 'status', 'aria-label': '회차 정보를 불러오는 중' });
    const rows = status.findAllByType('li');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((node) => String(node.props['aria-hidden']) === 'true')).toBe(true);
    expect(chapterButtons(root)).toHaveLength(0);
    expect(root.findAllByProps({ 'aria-label': '회차 페이지' })).toHaveLength(0);
  });
});
