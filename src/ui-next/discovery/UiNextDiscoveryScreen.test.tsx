import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalItemSummary,
  ExternalSourceFilterDefinition,
  ExternalSourceListInput,
} from '../../external-sources/contracts';
import type { ExternalSourceView } from '../../features/external-sources/useExternalSourceController';
import type { DiscoverySection, DiscoveryTab } from '../../features/discovery/discovery-config';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import { useDiscoveryScreenState, type DiscoveryScreenProps } from '../../features/discovery/useDiscoveryScreenState';
import { useDiscoverySection } from '../../features/discovery/useDiscoverySection';
import { useDiscoverySourceView } from '../../features/discovery/useDiscoverySourceView';
import { useDiscoveryCover } from '../../features/discovery/useDiscoveryCover';
import { actions, model } from '../test-fixtures';
import UiNextDiscoveryScreen from './UiNextDiscoveryScreen';

vi.mock('../../features/discovery/useDiscoveryScreenState', () => ({ useDiscoveryScreenState: vi.fn() }));
vi.mock('../../features/discovery/useDiscoverySection', () => ({ useDiscoverySection: vi.fn() }));
vi.mock('../../features/discovery/useDiscoverySourceView', () => ({ useDiscoverySourceView: vi.fn() }));
vi.mock('../../features/discovery/useDiscoveryCover', () => ({ useDiscoveryCover: vi.fn() }));
// Preserve the real filter sheet and controls, rendering portals inline in Node.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));

type ScreenState = ReturnType<typeof useDiscoveryScreenState>;
type SectionState = ReturnType<typeof useDiscoverySection>;
type SourceState = ReturnType<typeof useDiscoverySourceView>;
type CoverState = ReturnType<typeof useDiscoveryCover>;

const section: DiscoverySection = { id: 'row-1', sourceId: 'fixture.catalog', title: '추천 작품', mode: 'popular' };
const field: Extract<ExternalSourceFilterDefinition, { kind: 'select' }> = {
  id: 'genre',
  position: 0,
  kind: 'select',
  label: '장르',
  options: ['전체', '판타지'],
  defaultValue: 0,
};
function item(id = 'work-1', title = '테스트 작품'): ExternalItemSummary {
  return { key: { connectorId: section.sourceId, remoteId: id }, kind: 'work', title, importability: 'supported' };
}
function source(id = section.sourceId, title = '첫 번째 소스'): ExternalSourceView {
  return {
    id: id as ExternalSourceView['id'],
    title,
    kind: 'catalog',
    origin: 'plugin',
    connection: { state: 'connected' },
  };
}
function openArgs(value: ExternalItemSummary): [string, ExternalSourceListInput, string | undefined] {
  return [section.sourceId, { parentRef: `detail:${value.key.remoteId}` }, value.title];
}

let props: DiscoveryScreenProps;
let screen: ScreenState;
let rail: SectionState;
let view: SourceState;
let cover: CoverState;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { activeElement: null, documentElement: { style: { overflow: '' } }, body: {} });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const tabs: DiscoveryTab[] = [
    { id: 'tab-1', title: '나의 추천', hidden: false, density: 'comfortable', sections: [section] },
    {
      id: 'tab-2',
      title: '고정 소스',
      hidden: false,
      density: 'comfortable',
      pinnedSourceId: section.sourceId,
      sections: [section],
    },
  ];
  const config = { version: 1 as const, tabs };
  // Hooks own all I/O. Only the session key and source list are consumed by this UI.
  const session = { key: vi.fn(() => 'fixture-session') } as unknown as DiscoverySession;
  props = {
    library: { model: model([]), actions: actions() },
    open: vi.fn(),
    discovery: {
      active: true,
      setActive: vi.fn(),
      scope: 'fixture',
      session,
      config,
      ready: true,
      saving: false,
      error: '',
      save: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    sources: {
      sources: [source(), source('fixture.other', '두 번째 소스')],
    } as unknown as DiscoveryScreenProps['sources'],
  };
  screen = {
    config,
    scope: 'fixture',
    session,
    tabs,
    selected: tabs[0].id,
    setSelected: vi.fn(),
    tab: tabs[0],
    quickSource: undefined,
    setQuickSource: vi.fn(),
    viewMode: 'grid',
    setViewMode: vi.fn(),
    pinError: '',
    editing: false,
    setEditing: vi.fn(),
    quickJump: false,
    setQuickJump: vi.fn(),
    draftQuery: '',
    setDraftQuery: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    searchSource: 'all',
    setSearchSource: vi.fn(),
    refresh: 0,
    setRefresh: vi.fn(),
    refreshSections: vi.fn(),
    scroll: { current: null },
    positions: new Map(),
    dedicated: undefined,
    openQuick: vi.fn(),
    owned: vi.fn(() => false),
    sectionSources: [section.sourceId],
    rows: [section],
    togglePin: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn(),
    submitSearch: vi.fn(),
    resetSearch: vi.fn(),
    pinned: [section.sourceId],
  };
  rail = {
    ref: { current: null },
    rail: { current: null },
    near: true,
    input: { browseMode: 'popular' },
    page: { items: [item()] },
    candidate: undefined,
    loading: false,
    error: '',
    unsupported: undefined,
    unavailable: false,
    title: section.title,
    eyebrow: '첫 번째 소스',
    expanded: false,
    setExpanded: vi.fn(),
    collapse: vi.fn(),
    refreshSection: vi.fn(),
    itemOpenArgs: vi.fn(openArgs),
  };
  view = {
    root: { current: null },
    input: { browseMode: 'popular' },
    setRequest: vi.fn(),
    draftQuery: '',
    setDraftQuery: vi.fn(),
    values: {},
    setValues: vi.fn(),
    getFilterValue: vi.fn(() => 0),
    setFilterValue: vi.fn(),
    filtersOpen: false,
    setFiltersOpen: vi.fn(),
    data: {
      items: [item()],
      browse: undefined,
      busy: false,
      error: '',
      hasPage: true,
      more: false,
      retry: vi.fn(),
      loadMore: vi.fn(),
    },
    browse: undefined,
    definitions: [field],
    fields: [field],
    activeFilters: [],
    filterSummary: '',
    modes: ['popular', 'latest', 'search'],
    apply: vi.fn(),
    changeMode: vi.fn(),
    resetSearch: vi.fn(),
    resetFilters: vi.fn(),
    itemOpenArgs: vi.fn(openArgs),
    unavailable: false,
  };
  cover = { ref: { current: null }, near: false, url: undefined, failed: false, onError: vi.fn() };
  vi.mocked(useDiscoveryScreenState).mockImplementation(() => screen);
  vi.mocked(useDiscoverySection).mockImplementation(() => rail);
  vi.mocked(useDiscoverySourceView).mockImplementation(() => view);
  vi.mocked(useDiscoveryCover).mockImplementation(() => cover);
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
function button(root: ReactTestInstance, name: string | RegExp) {
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
function mount() {
  act(() => {
    renderer = create(<UiNextDiscoveryScreen {...props} />);
  });
  return renderer!.root;
}
function update() {
  act(() => renderer!.update(<UiNextDiscoveryScreen {...props} />));
}
function dedicated() {
  screen.dedicated = section;
  return mount();
}
function row(root: ReactTestInstance) {
  return root.findByProps({ 'aria-label': rail.title });
}
function skeletons(root: ReactTestInstance) {
  return root.findAll((node) => typeof node.type === 'string' && node.props.className === 'un-skeleton');
}

describe('discovery tabs and header', () => {
  it('renders tab names, selected state, pin icon, and delegates tab selection', () => {
    const root = mount();
    const tabs = root.findByProps({ role: 'tablist', 'aria-label': '탐색 분류' });
    expect(tabs.findAllByProps({ role: 'tab' }).map(text)).toEqual(['나의 추천', '고정 소스']);
    expect(button(tabs, '나의 추천').props['aria-selected']).toBe(true);
    const pinned = button(tabs, '고정 소스');
    expect(pinned.props['aria-selected']).toBe(false);
    expect(pinned.findAllByType('svg')).toHaveLength(1);
    expect(pinned.findByType('svg').props.className).toContain('lucide-pin');
    expect(String(pinned.findByType('svg').props['aria-hidden'])).toBe('true');
    expect(button(tabs, '나의 추천').findAllByType('svg')).toHaveLength(0);
    click(pinned);
    expect(screen.selectTab).toHaveBeenCalledExactlyOnceWith('tab-2');
  });

  it('selects and closes the quick-source tab', () => {
    screen.quickSource = 'fixture.other';
    const root = mount();
    const tabs = root.findByProps({ role: 'tablist' });
    expect(String(button(tabs, '두 번째 소스 닫기').props['aria-selected'])).toBe('true');
    expect(button(tabs, '나의 추천').props['aria-selected']).toBe(false);
    click(button(tabs, '두 번째 소스 닫기'));
    expect(screen.setQuickSource).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each([
    ['grid', 'compact', '작은 표지로 보기'],
    ['compact', 'grid', '큰 표지로 보기'],
  ] as const)('switches density from %s to %s', (current, next, label) => {
    screen.viewMode = current;
    const root = mount();
    click(button(root, label));
    expect(screen.setViewMode).toHaveBeenCalledExactlyOnceWith(next);
  });

  it('refreshes section lists', () => {
    click(button(mount(), '탐색 목록 새로고침'));
    expect(screen.refreshSections).toHaveBeenCalledExactlyOnceWith();
  });
  it('opens quick navigation', () => {
    click(button(mount(), '소스 빠른 이동'));
    expect(screen.setQuickJump).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('opens discovery editing', () => {
    click(button(mount(), '탐색 편집'));
    expect(screen.setEditing).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('tab search, empty state, and global error', () => {
  it('forwards draft changes and submits tab search', () => {
    screen.draftQuery = '기존 검색어';
    const root = mount();
    const input = root.findByProps({ 'aria-label': '탐색 작품 검색' });
    expect(input.props.value).toBe('기존 검색어');
    act(() => input.props.onChange({ target: { value: '새 검색어' } }));
    expect(screen.setDraftQuery).toHaveBeenCalledExactlyOnceWith('새 검색어');
    const preventDefault = vi.fn();
    act(() => root.findByType('form').props.onSubmit({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(screen.submitSearch).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([1, 2])('offers the search-source selector only for multiple sources (%s)', (count) => {
    screen.sectionSources = ['fixture.catalog', 'fixture.other'].slice(0, count);
    const root = mount();
    const selects = root.findAllByProps({ 'aria-label': '검색할 소스' });
    expect(selects).toHaveLength(count > 1 ? 1 : 0);
    if (count > 1) {
      expect(selects[0].findAllByType('option').map(text)).toEqual(['모든 소스', '첫 번째 소스', '두 번째 소스']);
      act(() => selects[0].props.onChange({ target: { value: 'fixture.other' } }));
      expect(screen.setSearchSource).toHaveBeenCalledExactlyOnceWith('fixture.other');
    }
  });

  it('resets an active tab search', () => {
    screen.query = '검색 중';
    click(button(mount(), '검색 초기화'));
    expect(screen.resetSearch).toHaveBeenCalledExactlyOnceWith();
  });

  it('omits tab search on a dedicated source', () => {
    const root = dedicated();
    expect(root.findAllByProps({ 'aria-label': '탐색 작품 검색' })).toHaveLength(0);
    expect(root.findByProps({ 'aria-label': '소스 작품 검색' })).toBeDefined();
  });

  it('offers editing and source settings when there are no rows', () => {
    screen.rows = [];
    const root = mount();
    expect(text(root)).toContain('나만의 탐색 화면을 만들어 보세요');
    click(button(root, '소스와 목록 고르기'));
    expect(screen.setEditing).toHaveBeenCalledExactlyOnceWith(true);
    click(button(root, '소스 관리'));
    expect(props.library.actions.header.openExternalSourceSettings).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByType('form')).toHaveLength(0);
  });

  it('shows discovery errors and retries through discovery.refresh', () => {
    props.discovery.error = '탐색 설정을 불러오지 못했습니다';
    const root = mount();
    const status = root.findByProps({ role: 'status' });
    expect(text(status)).toContain(props.discovery.error);
    click(button(status, '다시 시도'));
    expect(props.discovery.refresh).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('section rows', () => {
  it('renders page items and delegates opening with exactly itemOpenArgs', () => {
    const chosen = item('chosen', '선택한 작품');
    rail.page = { items: [item(), chosen] };
    const root = mount();
    const sectionRoot = row(root);
    expect(button(sectionRoot, '1위 테스트 작품 상세 보기')).toBeDefined();
    click(button(sectionRoot, '2위 선택한 작품 상세 보기'));
    expect(rail.itemOpenArgs).toHaveBeenCalledExactlyOnceWith(chosen);
    expect(props.open).toHaveBeenCalledExactlyOnceWith(...openArgs(chosen));
  });

  it.each([false, true])('renders the owned badge only when owned returns %s', (owned) => {
    vi.mocked(screen.owned).mockReturnValue(owned);
    const root = mount();
    const card = button(row(root), '1위 테스트 작품 상세 보기');
    expect(text(card).includes('보관 중')).toBe(owned);
    expect(screen.owned).toHaveBeenCalledWith(rail.page!.items[0]);
  });

  it('renders busy skeletons before the first page is available', () => {
    rail.page = undefined;
    rail.loading = true;
    const sectionRoot = row(mount());
    expect(sectionRoot.findByProps({ 'aria-busy': true })).toBeDefined();
    expect(skeletons(sectionRoot).length).toBeGreaterThan(0);
    expect(skeletons(sectionRoot).every((node) => String(node.props['aria-hidden']) === 'true')).toBe(true);
  });

  it('shows a row error and retries the section', () => {
    rail.page = undefined;
    rail.error = '작품 목록을 불러오지 못했습니다';
    const sectionRoot = row(mount());
    expect(text(sectionRoot.findByProps({ role: 'status' }))).toBe(rail.error);
    click(button(sectionRoot, '다시 시도'));
    expect(rail.refreshSection).toHaveBeenCalledExactlyOnceWith();
  });

  it('offers the candidate page through 새 목록 보기', () => {
    rail.candidate = { items: [item('updated', '새 작품')] };
    click(button(row(mount()), '새 목록 보기'));
    expect(rail.refreshSection).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['unsupported', 'unavailable'] as const)('explains an %s section', (reason) => {
    const message = '이 소스는 목록 탐색을 지원하지 않습니다.';
    if (reason === 'unsupported') rail.unsupported = message;
    else rail.unavailable = true;
    const sectionRoot = row(mount());
    expect(text(sectionRoot)).toContain(reason === 'unsupported' ? message : '소스를 쓸 수 없어요.');
    expect(skeletons(sectionRoot)).toHaveLength(0);
    expect(sectionRoot.findAllByType('button').map(text)).not.toContain('전체 보기');
  });

  it('expands the full catalog and delegates collapsing it', () => {
    const root = mount();
    expect(button(row(root), '전체 보기').props['aria-expanded']).toBe(false);
    click(button(row(root), '전체 보기'));
    expect(rail.setExpanded).toHaveBeenCalledExactlyOnceWith(true);
    rail.expanded = true;
    update();
    expect(useDiscoverySourceView).toHaveBeenCalledWith(
      expect.objectContaining({ section, controls: false, query: screen.query }),
    );
    expect(root.findAllByProps({ 'aria-label': '소스 작품 검색' })).toHaveLength(0);
    expect(button(row(root), '접기').props['aria-expanded']).toBe(true);
    click(button(row(root), '접기'));
    expect(rail.collapse).toHaveBeenCalledExactlyOnceWith();
  });

  it('opens cloud-file folders even when catalog browsing is unsupported', () => {
    props.sources = { ...props.sources, sources: [{ ...source(), kind: 'cloud_file' }] };
    rail.unsupported = '파일 소스입니다. 폴더 보기에서 파일을 찾아보세요.';
    click(button(row(mount()), '폴더 보기'));
    expect(props.open).toHaveBeenCalledExactlyOnceWith(section.sourceId, {});
    expect(rail.setExpanded).not.toHaveBeenCalled();
  });

  it('renders the cover hook result and forwards image failures', () => {
    cover.near = true;
    cover.url = 'data:image/png;base64,fixture';
    const root = mount();
    const card = button(row(root), '1위 테스트 작품 상세 보기');
    expect(card.findByType('img').props.src).toBe(cover.url);
    expect(useDiscoveryCover).toHaveBeenCalledWith({
      item: rail.page!.items[0],
      session: screen.session,
      showCover: true,
    });
    act(() => card.findByType('img').props.onError());
    expect(cover.onError).toHaveBeenCalledExactlyOnceWith();
    cover.failed = true;
    update();
    expect(button(row(root), '1위 테스트 작품 상세 보기').findAllByType('img')).toHaveLength(0);
  });

  it.each(['popular', 'empty-filters', 'latest', 'query', 'filters', 'compact'] as const)(
    'shows a top-ten chart only for unfiltered popular grid rows (%s)',
    (condition) => {
      const config: DiscoverySection = { ...section };
      if (condition === 'latest') config.mode = 'latest';
      if (condition === 'query') screen.query = '검색어';
      if (condition === 'filters') config.filters = [{ position: 0, value: 1 }];
      if (condition === 'empty-filters') config.filters = [];
      if (condition === 'compact') screen.viewMode = 'compact';
      screen.rows = [config];
      const items = Array.from({ length: 23 }, (_, index) => item(`work-${index + 1}`, `작품 ${index + 1}`));
      rail.page = { items };
      const root = mount();
      const sectionRoot = row(root);
      const ranked = condition === 'popular' || condition === 'empty-filters';
      const count = ranked ? 10 : 20;
      expect(sectionRoot.props.className.split(' ').includes('is-ranked')).toBe(ranked);
      const cards = sectionRoot
        .findAllByType('button')
        .filter((node) => / 상세 보기$/.test(node.props['aria-label'] ?? ''));
      expect(cards).toHaveLength(count);
      cards.forEach((card, index) => {
        expect(card.props['aria-label']).toBe(`${ranked ? `${index + 1}위 ` : ''}${items[index].title} 상세 보기`);
        expect(card.props.className.split(' ').includes('has-rank')).toBe(ranked);
        const numerals = card.findAllByProps({ className: 'un-poster-rank' });
        expect(numerals).toHaveLength(ranked ? 1 : 0);
        if (ranked) {
          expect(numerals[0].children).toEqual([String(index + 1)]);
          expect(String(numerals[0].props['aria-hidden'])).toBe('true');
        }
      });
      click(cards[count - 1]);
      expect(rail.itemOpenArgs).toHaveBeenCalledExactlyOnceWith(items[count - 1]);
      expect(props.open).toHaveBeenCalledExactlyOnceWith(...openArgs(items[count - 1]));
    },
  );
});

describe('dedicated source view', () => {
  it.each([
    ['인기', 'popular', true],
    ['최신', 'latest', false],
  ] as const)('routes the %s chip to changeMode(%s)', (label, mode, pressed) => {
    const root = dedicated();
    const group = root.findByProps({ role: 'group', 'aria-label': '작품 목록' });
    const chip = button(group, label);
    expect(chip.props['aria-pressed']).toBe(pressed);
    click(chip);
    expect(view.changeMode).toHaveBeenCalledExactlyOnceWith(mode);
  });

  it('submits source search through apply and resets the active search', () => {
    view.input = { browseMode: 'search', query: '기존 검색어' };
    view.draftQuery = '기존 검색어';
    const root = dedicated();
    const input = root.findByProps({ 'aria-label': '소스 작품 검색' });
    expect(input.props.value).toBe('기존 검색어');
    act(() => input.props.onChange({ target: { value: '바뀐 검색어' } }));
    expect(view.setDraftQuery).toHaveBeenCalledExactlyOnceWith('바뀐 검색어');
    const preventDefault = vi.fn();
    act(() => root.findByType('form').props.onSubmit({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(view.apply).toHaveBeenCalledExactlyOnceWith();
    click(button(root, '검색 초기화'));
    expect(view.resetSearch).toHaveBeenCalledExactlyOnceWith();
    expect(screen.resetSearch).not.toHaveBeenCalled();
  });

  it('opens the filter sheet, forwards filter changes/reset, and applies before closing', () => {
    const root = dedicated();
    click(button(root, '필터'));
    expect(view.setFiltersOpen).toHaveBeenNthCalledWith(1, true);
    // Inject the hook's next render after the command, without mocking the sheet.
    view.filtersOpen = true;
    update();
    const sheet = root.findByProps({ role: 'dialog', 'aria-label': '필터' });
    expect(sheet.findByType('legend').children).toEqual(['장르']);
    click(button(sheet, '조건 초기화'));
    expect(view.resetFilters).toHaveBeenCalledExactlyOnceWith();
    click(button(sheet, '판타지'));
    expect(view.setFilterValue).toHaveBeenCalledExactlyOnceWith('genre', 1);
    click(button(sheet, '적용'));
    expect(view.apply).toHaveBeenCalledExactlyOnceWith();
    expect(view.setFiltersOpen).toHaveBeenNthCalledWith(2, false);
    expect(vi.mocked(view.apply).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(view.setFiltersOpen).mock.invocationCallOrder[1],
    );
    view.filtersOpen = false;
    update();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('displays source errors and routes retry to data.retry', () => {
    view.data = { ...view.data, items: [], hasPage: false, error: '소스에 연결하지 못했습니다' };
    const root = dedicated();
    const status = root.findByProps({ role: 'status' });
    expect(text(status)).toContain(view.data.error);
    click(button(status, '다시 시도'));
    expect(view.data.retry).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(['다음 페이지 연결 실패', '저장된 목록입니다. 다시 시도해 주세요.'])(
    'keeps results and exposes recovery when a retained page reports %s',
    (error) => {
      view.data.error = error;
      view.data.more = true;
      const root = dedicated();
      const status = root.findByProps({ role: 'status' });
      expect(text(status)).toContain(error);
      expect(text(root)).toContain(view.data.items[0].title);
      click(button(status, '다시 시도'));
      expect(view.data.retry).toHaveBeenCalledExactlyOnceWith();
      view.data.error = '';
      update();
      expect(button(root, '더 불러오기')).toBeDefined();
    },
  );

  it('loads more results through data.loadMore', () => {
    view.data.more = true;
    click(button(dedicated(), '더 불러오기'));
    expect(view.data.loadMore).toHaveBeenCalledExactlyOnceWith();
  });

  it('disables loading more while busy', () => {
    view.data.more = true;
    view.data.busy = true;
    const root = dedicated();
    expect(button(root, '불러오는 중…').props.disabled).toBe(true);
    expect(root.findByProps({ 'aria-busy': true })).toBeDefined();
  });

  it('shows source skeletons while the first page is loading', () => {
    view.data = { ...view.data, items: [], hasPage: false, busy: true };
    const root = dedicated();
    expect(root.findByProps({ 'aria-busy': true })).toBeDefined();
    expect(skeletons(root).length).toBeGreaterThan(0);
  });

  it('shows an empty-result message after an empty page', () => {
    view.data.items = [];
    const root = dedicated();
    expect(text(root)).toContain('조건에 맞는 작품이 없어요.');
    expect(skeletons(root)).toHaveLength(0);
  });

  it('shows unavailable guidance without source controls', () => {
    view.unavailable = true;
    const root = dedicated();
    expect(text(root)).toContain('소스를 쓸 수 없어요. 소스 관리에서 연결을 확인해 주세요.');
    expect(root.findAllByProps({ 'aria-label': '소스 작품 검색' })).toHaveLength(0);
    expect(skeletons(root)).toHaveLength(0);
  });

  it('uses source-view itemOpenArgs for dedicated cards', () => {
    const chosen = item('dedicated', '소스 작품');
    view.data.items = [chosen];
    click(button(dedicated(), '소스 작품 상세 보기'));
    expect(view.itemOpenArgs).toHaveBeenCalledExactlyOnceWith(chosen);
    expect(props.open).toHaveBeenCalledExactlyOnceWith(...openArgs(chosen));
    expect(rail.itemOpenArgs).not.toHaveBeenCalled();
  });
});
