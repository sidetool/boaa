import { Children, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import { actions, model, novel } from '../test-fixtures';
import type { LibraryProgress } from '../library/contract';
import type {
  HomeHeroItem,
  HomeRowConfig,
  HomeRowItem,
  HomeRowOption,
  HomeRowView,
  UiNextHomeAdapter,
} from './contract';
import { UiNextHomeScreen } from './UiNextHomeScreen';

// Keep the real Sheet and HomeEditor; only adapt DOM portals to the Node renderer.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));

// Ref-backed scrolling must emit events so hero index assertions also catch autoplay.
class ScrollElement extends EventTarget {
  constructor(count = 0) {
    super();
    this.children = Array.from({ length: count }, (_, index) => ({ offsetLeft: index * 336, offsetWidth: 320 }));
  }
  children: { offsetLeft: number; offsetWidth: number }[];
  offsetLeft = 0;
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  clientWidth = 320;
  scrollWidth = 960;
  scrollLeft = 0;
  scrollTop = 0;
  focus = vi.fn();
  scrollTo = vi.fn((options: ScrollToOptions) => {
    this.scrollLeft = options.left ?? this.scrollLeft;
    this.dispatchEvent(new Event('scroll'));
  });
  scrollBy = vi.fn((options: ScrollToOptions) => this.scrollTo({ left: this.scrollLeft + (options.left ?? 0) }));
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: '16px', scrollPaddingLeft: '0px' }));
  vi.stubGlobal('document', {
    activeElement: null,
    documentElement: { style: { overflow: '' } },
    body: {},
  });
  const events = new EventTarget();
  vi.stubGlobal('window', {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    matchMedia: vi.fn(() => ({ matches: false })),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function hidden(node: ReactTestInstance): boolean {
  return String(node.props['aria-hidden']) === 'true' || Boolean(node.parent && hidden(node.parent));
}

// Roles/names used by this screen, including implicit HTML roles and hidden slides.
function byRole(root: ReactTestInstance, role: string, name?: string | RegExp): ReactTestInstance {
  const implicit: Record<string, string> = {
    button: 'button',
    main: 'main',
    h1: 'heading',
    h2: 'heading',
    li: 'listitem',
    ul: 'list',
  };
  return root.find((node) => {
    if (typeof node.type !== 'string' || hidden(node)) return false;
    const actual =
      node.props.role ?? (node.type === 'section' && node.props['aria-label'] ? 'region' : implicit[node.type]);
    if (actual !== role) return false;
    const label: string = node.props['aria-label'] ?? text(node).replace(/\s+/g, ' ').trim();
    return name === undefined || (typeof name === 'string' ? label === name : name.test(label));
  });
}

function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

function book(id = 'novel-1', title = '테스트 소설'): Extract<LibraryWorkItem, { kind: 'book' }> {
  const view = model([novel({ id, title })]).collection.visibleBooks[0];
  return { kind: 'book', key: `book:${id}`, book: view };
}

const progress: LibraryProgress = { progress: 0.4, percent: 40, subline: '읽는 중' };
function hero(item = book(), overrides: Partial<HomeHeroItem> = {}): HomeHeroItem {
  return {
    reason: 'continue',
    item,
    progress,
    positionLabel: '12화',
    lastReadLabel: '어제',
    resumeLabel: '12화 이어 읽기',
    tags: ['TXT'],
    resume: vi.fn(),
    openDetail: vi.fn(),
    ...overrides,
  };
}

function row(overrides: Partial<HomeRowView> = {}): HomeRowView {
  const item = book();
  return {
    config: { id: 'recently-added', kind: 'recently-added', visible: true },
    title: '최근 추가한 작품',
    status: 'ready',
    items: [{ kind: 'library', key: item.key, item }],
    ...overrides,
  };
}

function adapter(overrides: Partial<UiNextHomeAdapter> = {}): UiNextHomeAdapter {
  return {
    status: 'ready',
    hero: [],
    rows: [],
    config: [],
    rowOptions: [],
    rowLabel: vi.fn((config: HomeRowConfig) => config.id),
    setConfig: vi.fn(),
    resetConfig: vi.fn(),
    importFiles: vi.fn(),
    openDiscovery: vi.fn(),
    addSamples: vi.fn(),
    library: {
      bookProgress: vi.fn(() => progress),
      externalProgress: vi.fn(() => progress),
      bookMenu: vi.fn(() => []),
      externalMenu: vi.fn(() => []),
      taskForBook: vi.fn(),
      taskForExternal: vi.fn(),
      activate: vi.fn(),
    },
    ...overrides,
  };
}

function mount(home = adapter()) {
  const nodes = new Map<string, ScrollElement>();
  const navigation = {
    activeTab: 'home' as const,
    isReader: false,
    searchFocusRequest: 0,
    openHome: vi.fn(),
    openLibraryRoot: vi.fn(),
    openSettings: vi.fn(),
    focusSearch: vi.fn(),
  };
  const libraryProps = { model: model([novel()]), actions: actions() };
  const screen = (value: UiNextHomeAdapter) => (
    <UiNextHomeScreen adapter={value} navigation={navigation} libraryProps={libraryProps} />
  );
  act(() => {
    renderer = create(screen(home), {
      createNodeMock: (element) => {
        const node = new ScrollElement(
          element.props.className === 'un-continue-track' ? Children.count(element.props.children) : 0,
        );
        nodes.set(element.props.className, node);
        return node;
      },
    });
  });
  return {
    root: renderer!.root,
    home,
    track: nodes.get('un-continue-track'),
    update: (value: UiNextHomeAdapter) => act(() => renderer!.update(screen(value))),
  };
}

function skeletons(root: ReactTestInstance) {
  return root.findAll((node) => typeof node.type === 'string' && node.props.className === 'un-skeleton');
}

describe('home bootstrap and empty state', () => {
  it('shows a busy skeleton while loading, hiding stale hero and row content', () => {
    const { root } = mount(adapter({ status: 'loading', hero: [hero()], rows: [row()] }));
    expect(byRole(root, 'main').props['aria-busy']).toBe(true);
    expect(skeletons(root).length).toBeGreaterThan(0);
    expect(skeletons(root).every(hidden)).toBe(true);
    expect(text(root)).not.toContain('테스트 소설');
  });

  it('shows a failure message instead of stale home content', () => {
    const { root } = mount(adapter({ status: 'failed', hero: [hero()], rows: [row()] }));
    expect(byRole(root, 'main').props['aria-busy']).toBe(false);
    expect(text(root)).toContain('서재를 불러오지 못했어요');
    expect(text(root)).toContain('잠시 뒤 다시 열어 주세요.');
    expect(text(root)).not.toContain('테스트 소설');
    expect(skeletons(root)).toHaveLength(0);
  });

  it.each([
    ['파일 가져오기', 'importFiles'],
    ['작품 탐색', 'openDiscovery'],
    ['샘플 작품 넣어 보기', 'addSamples'],
  ] as const)('calls the adapter from the empty-home %s button', (label, action) => {
    const { root, home } = mount();
    expect(text(byRole(root, 'heading', '읽을 작품을 넣어 볼까요?'))).toBe('읽을 작품을 넣어 볼까요?');
    click(byRole(root, 'button', label));
    expect(home[action]).toHaveBeenCalledExactlyOnceWith();
  });

  it('treats ready rows without items as empty and omits unavailable empty-home actions', () => {
    const { root } = mount(adapter({ rows: [row({ items: [] })], openDiscovery: undefined, addSamples: undefined }));
    expect(byRole(root, 'heading', '읽을 작품을 넣어 볼까요?')).toBeDefined();
    expect(root.findAllByType('button').map(text)).toEqual(['파일 가져오기']);
  });
});

describe('home hero', () => {
  it('omits dots and arrows for a single item', () => {
    const { root } = mount(adapter({ hero: [hero()] }));
    expect(byRole(root, 'region', '이어 읽기')).toBeDefined();
    expect(root.findAllByProps({ role: 'tablist' })).toHaveLength(0);
    expect(root.findAllByProps({ 'aria-label': '이전 작품' })).toHaveLength(0);
    expect(root.findAllByProps({ 'aria-label': '다음 작품' })).toHaveLength(0);
  });

  it('renders one dot per item and navigates manually with dots and arrows', () => {
    const items = [hero(), hero(book('second', '두 번째 작품')), hero(book('third', '세 번째 작품'))];
    const { root } = mount(adapter({ hero: items }));
    const dots = byRole(root, 'tablist', '이어 읽기 작품');
    expect(dots.findAllByProps({ role: 'tab' })).toHaveLength(items.length);
    expect(root.findAllByProps({ 'aria-label': '이전 작품' })).toHaveLength(0);
    click(byRole(dots, 'tab', '2번째 · 두 번째 작품'));
    expect(byRole(dots, 'tab', '2번째 · 두 번째 작품').props['aria-selected']).toBe(true);
    click(byRole(root, 'button', '다음 작품'));
    expect(byRole(dots, 'tab', '3번째 · 세 번째 작품').props['aria-selected']).toBe(true);
    expect(root.findAllByProps({ 'aria-label': '다음 작품' })).toHaveLength(0);
    click(byRole(root, 'button', '이전 작품'));
    expect(byRole(dots, 'tab', '2번째 · 두 번째 작품').props['aria-selected']).toBe(true);
  });

  it('labels a new-work hero as 새로 들어온 작품', () => {
    const { root } = mount(adapter({ hero: [hero(book(), { reason: 'new', lastReadLabel: '' })] }));
    const banner = byRole(root, 'region', '새로 들어온 작품');
    expect(text(banner)).toContain('새로 들어온 작품');
  });

  it.each([
    ['12화 이어 읽기', 'resume'],
    ['작품 정보', 'openDetail'],
    ['테스트 소설 작품 정보', 'openDetail'],
  ] as const)('routes the %s hero button to %s', (label, action) => {
    const item = hero();
    const { root } = mount(adapter({ hero: [item] }));
    click(byRole(root, 'button', label));
    expect(item[action]).toHaveBeenCalledExactlyOnceWith();
    expect(item[action === 'resume' ? 'openDetail' : 'resume']).not.toHaveBeenCalled();
  });

  it('never advances automatically after timers run, including after manual navigation', () => {
    vi.useFakeTimers();
    const { root } = mount(adapter({ hero: [hero(), hero(book('second', '두 번째 작품'))] }));
    const dots = byRole(root, 'tablist', '이어 읽기 작품');
    const selected = () => dots.findAllByProps({ role: 'tab' }).map((node) => node.props['aria-selected']);
    expect(selected()).toEqual([true, false]);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(selected()).toEqual([true, false]);
    click(byRole(dots, 'tab', '2번째 · 두 번째 작품'));
    expect(selected()).toEqual([false, true]);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(selected()).toEqual([false, true]);
  });
});

describe('home rows and work menus', () => {
  it('shows the home title without a hero, hides ready empty rows, and renders loading/failed rows', () => {
    const { root } = mount(
      adapter({
        rows: [
          row(),
          row({ config: { id: 'empty', kind: 'finished', visible: true }, title: '빈 줄', items: [] }),
          row({
            config: { id: 'loading', kind: 'unread', visible: true },
            title: '불러오는 줄',
            status: 'loading',
            items: [],
          }),
          row({
            config: { id: 'failed', kind: 'favorites', visible: true },
            title: '실패한 줄',
            status: 'failed',
            items: [],
          }),
        ],
      }),
    );
    expect(byRole(root, 'heading', '홈')).toBeDefined();
    expect(byRole(root, 'button', '테스트 소설 열기')).toBeDefined();
    expect(root.findAllByProps({ 'aria-label': '빈 줄' })).toHaveLength(0);
    const loading = byRole(root, 'region', '불러오는 줄');
    expect(loading.findByProps({ 'aria-busy': true })).toBeDefined();
    expect(skeletons(loading).length).toBeGreaterThan(0);
    expect(text(byRole(root, 'region', '실패한 줄'))).toContain('목록을 불러오지 못했어요.');
  });

  it.each(['최근 추가한 작품', '전체 보기'])('calls openAll from the row %s button', (label) => {
    const openAll = vi.fn();
    const { root } = mount(adapter({ rows: [row({ openAll })] }));
    click(byRole(byRole(root, 'region', '최근 추가한 작품'), 'button', label));
    expect(openAll).toHaveBeenCalledExactlyOnceWith();
  });

  it('renders a plain row heading and no 전체 보기 without openAll', () => {
    const { root } = mount(adapter({ rows: [row()] }));
    const section = byRole(root, 'region', '최근 추가한 작품');
    expect(text(byRole(section, 'heading', '최근 추가한 작품'))).toBe('최근 추가한 작품');
    expect(section.findAllByType('button').map(text)).not.toContain('전체 보기');
  });

  it('numbers ranked discovery cards in row order and opens the chosen discovery work', () => {
    const items: HomeRowItem[] = ['첫 번째 추천', '두 번째 추천'].map((title, index) => ({
      kind: 'discovery',
      key: `discovery:${index}`,
      work: { id: String(index), title, open: vi.fn() },
    }));
    const { root } = mount(adapter({ rows: [row({ title: '인기 작품', ranked: true, items })] }));
    const section = byRole(root, 'region', '인기 작품');
    for (const [index, title] of ['첫 번째 추천', '두 번째 추천'].entries()) {
      const card = byRole(section, 'button', `${title} 상세 보기`);
      const rank = card.find(
        (node) =>
          node.type === 'span' &&
          String(node.props['aria-hidden']) === 'true' &&
          node.children.includes(String(index + 1)),
      );
      expect(rank.children).toEqual([String(index + 1)]);
      click(card);
      const item = items[index];
      if (item.kind !== 'discovery') throw new Error('Expected discovery fixture');
      expect(item.work.open).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it('opens a tile menu and runs its action through the real sheet', () => {
    const item = book();
    const run = vi.fn();
    const home = adapter({ rows: [row({ items: [{ kind: 'library', key: item.key, item }] })] });
    home.library.bookMenu = vi.fn(() => [{ id: 'remove', label: '휴지통으로 이동', danger: true, run }]);
    const { root } = mount(home);
    click(byRole(root, 'button', '테스트 소설 더보기'));
    expect(home.library.bookMenu).toHaveBeenCalledExactlyOnceWith(item.book);
    expect(run).not.toHaveBeenCalled();
    click(byRole(byRole(root, 'dialog', '테스트 소설'), 'button', '휴지통으로 이동'));
    expect(run).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});

function editor(overrides: Partial<UiNextHomeAdapter> = {}) {
  const config: HomeRowConfig[] = [
    { id: '최근 추가한 작품', kind: 'recently-added', visible: true },
    { id: '즐겨찾기', kind: 'favorites', visible: false },
    { id: '내 책장', kind: 'shelf', shelfId: 'shelf-1', visible: true },
  ];
  const home = adapter({ rows: [row()], config, ...overrides });
  const { root } = mount(home);
  click(byRole(root, 'button', '홈 화면 편집'));
  return { root, home, config, sheet: byRole(root, 'dialog', '홈 화면 편집') };
}

describe('home editor sheet', () => {
  it.each([
    ['최근 추가한 작품', 0, false],
    ['즐겨찾기', 1, true],
  ] as const)('toggles %s visibility (row %s) to %s through setConfig', (label, index, visible) => {
    const { home, config, sheet } = editor();
    const toggle = byRole(sheet, 'switch', `${label} 표시`);
    expect(toggle.props['aria-checked']).toBe(!visible);
    click(toggle);
    expect(home.setConfig).toHaveBeenCalledExactlyOnceWith(
      config.map((row, i) => (i === index ? { ...row, visible } : row)),
    );
    expect(byRole(sheet, 'switch', `${label} 표시`).props['aria-checked']).toBe(visible);
  });

  it('moves a row down on ArrowDown and preserves the other rows and visibility', () => {
    const { home, config, sheet } = editor();
    const preventDefault = vi.fn();
    act(() =>
      byRole(sheet, 'button', '최근 추가한 작품 순서 바꾸기').props.onKeyDown({ key: 'ArrowDown', preventDefault }),
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(home.setConfig).toHaveBeenCalledExactlyOnceWith([config[1], config[0], config[2]]);
    expect(sheet.findAllByProps({ role: 'switch' }).map((node) => node.props['aria-label'])).toEqual([
      '즐겨찾기 표시',
      '최근 추가한 작품 표시',
      '내 책장 표시',
    ]);
  });

  it.each([
    { kind: 'unread', label: '아직 안 읽은 작품', hint: '새로 시작할 작품' },
    { kind: 'shelf', shelfId: 'shelf-2', label: '두 번째 책장', hint: '책장에 담은 작품' },
  ] satisfies HomeRowOption[])('adds the chosen $kind option to the existing config', (option) => {
    const { home, config, sheet } = editor({
      rowOptions: [{ kind: 'finished', label: '완독한 작품', hint: '끝까지 읽은 작품' }, option],
    });
    click(byRole(sheet, 'button', '줄 추가'));
    const choice = byRole(sheet, 'listitem', new RegExp(`^${option.label}${option.hint}`));
    click(byRole(choice, 'button', '넣기'));
    expect(home.setConfig).toHaveBeenCalledExactlyOnceWith([
      ...config,
      {
        id: option.shelfId ? `${option.kind}:${option.shelfId}` : option.kind,
        kind: option.kind,
        visible: true,
        shelfId: option.shelfId,
        discoveryTabId: undefined,
      },
    ]);
    expect(byRole(sheet, 'button', '줄 추가')).toBeDefined();
  });

  it('removes only the chosen shelf row', () => {
    const { home, config, sheet } = editor();
    click(byRole(sheet, 'button', '내 책장 줄 빼기'));
    expect(home.setConfig).toHaveBeenCalledExactlyOnceWith(config.slice(0, 2));
    expect(sheet.findAllByProps({ 'aria-label': '내 책장 표시' })).toHaveLength(0);
  });

  it('delegates restoring defaults to resetConfig', () => {
    const { home, sheet } = editor();
    click(byRole(sheet, 'button', '기본값으로'));
    expect(home.resetConfig).toHaveBeenCalledExactlyOnceWith();
    expect(home.setConfig).not.toHaveBeenCalled();
  });
});

describe('home hero late-arriving front card', () => {
  it('returns to scrollLeft zero when the first work changes before reader interaction', () => {
    const older = hero(book('older', '이전에 읽은 작품'));
    const newest = hero(book('newest', '가장 최근 작품'));
    const home = adapter({ hero: [older, newest] });
    const { root, track, update } = mount(home);
    // Simulate browser snap retaining the old card when a new work is inserted before it.
    track!.scrollLeft = 336;
    update({ ...home, hero: [newest, older] });
    expect(track!.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, behavior: 'instant' });
    expect(track!.scrollLeft).toBe(0);
    expect(byRole(root, 'tab', '1번째 · 가장 최근 작품').props['aria-selected']).toBe(true);
  });

  it.each(['onPointerDown', 'onWheel', 'onKeyDown'] as const)(
    'preserves the reader position after %s even when a newer work arrives',
    (event) => {
      const older = hero(book('older', '이전에 읽은 작품'));
      const newest = hero(book('newest', '가장 최근 작품'));
      const home = adapter({ hero: [older, newest] });
      const { root, track, update } = mount(home);
      act(() =>
        root
          .findByProps({ className: 'un-continue-track' })
          .props[event]({ key: 'ArrowRight', preventDefault: vi.fn() }),
      );
      act(() => track!.scrollTo({ left: 336 }));
      track!.scrollTo.mockClear();
      update({ ...home, hero: [newest, older] });
      expect(track!.scrollLeft).toBe(336);
      expect(track!.scrollTo).not.toHaveBeenCalled();
    },
  );

  it('keeps the position when only the front card metadata changes', () => {
    const first = hero();
    const home = adapter({ hero: [first, hero(book('other', '다른 작품'))] });
    const { track, update } = mount(home);
    track!.scrollLeft = 336;
    update({ ...home, hero: [{ ...first, lastReadLabel: '방금' }, home.hero[1]] });
    expect(track!.scrollLeft).toBe(336);
    expect(track!.scrollTo).not.toHaveBeenCalled();
  });
});

describe('home rank numeral width', () => {
  it('uses is-wide for ranks 10 and above, keeping single digit ranks narrow', () => {
    const items: HomeRowItem[] = Array.from({ length: 12 }, (_, index) => ({
      kind: 'discovery',
      key: `rank:${index}`,
      work: { id: String(index), title: `추천 ${index + 1}`, open: vi.fn() },
    }));
    const { root } = mount(adapter({ rows: [row({ title: '인기 순위', ranked: true, items })] }));
    const ranks = root.findAll(
      (node) => node.type === 'span' && String(node.props.className).split(' ').includes('un-poster-rank'),
    );
    expect(ranks).toHaveLength(12);
    for (const [index, rank] of ranks.entries()) {
      expect(rank.children).toEqual([String(index + 1)]);
      expect(rank.props.className.split(' ').includes('is-wide')).toBe(index >= 9);
    }
  });
});
