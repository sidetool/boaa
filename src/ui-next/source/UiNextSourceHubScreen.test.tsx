import { useTranslatedTitle } from '../../features/translation/use-translated-title';
import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalItemKeyId } from '../../external-sources/contracts';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
} from '../../features/external-sources/external-source-controller-contract';
import type { SourceHubScreenProps } from '../../features/external-sources/source-hub-contract';
import type { ImportTaskView } from '../../features/import/import-task-projection';
import { episode, sourceId } from '../../features/external-sources/source-command-test-fixtures';
import { canSelectItem } from '../../features/external-sources/source-hub-item-model';
import { sourceHubItemActions } from '../../features/external-sources/source-hub-item-actions';
import { paginateReleases } from '../../features/external-sources/source-release-list-model';
import { SourceStreamReader } from '../../features/external-sources/SourceStreamReader';
import { useSourceHubModel } from '../../features/external-sources/useSourceHubModel';
import { useSourceReleaseList } from '../../features/external-sources/useSourceReleaseList';
import { actions, model, novel } from '../test-fixtures';
import UiNextSourceHubScreen from './UiNextSourceHubScreen';

vi.mock('../../features/translation/use-translated-title', () => ({
  useTranslatedTitle: vi.fn((title: string) => title),
}));
vi.mock('../../features/external-sources/useSourceHubModel', () => ({ useSourceHubModel: vi.fn() }));
vi.mock('../../features/external-sources/useSourceReleaseList', () => ({ useSourceReleaseList: vi.fn() }));
vi.mock('../../features/external-sources/SourceStreamReader', () => ({ SourceStreamReader: vi.fn(() => null) }));
// Keep the real sheets/filters/item actions while rendering DOM portals inline in Node.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));

type Hub = ReturnType<typeof useSourceHubModel>;
type Releases = ReturnType<typeof useSourceReleaseList>;
let c: ExternalSourceController;
let hub: Hub;
let list: Releases;
let props: SourceHubScreenProps;
let renderer: ReactTestRenderer | undefined;

// Required controller ports follow the existing SourceHubScreen fixture. Optional
// capabilities remain explicit so the real item-action helpers exercise their guards.
function controller(): ExternalSourceController {
  return {
    open: true,
    loading: false,
    busy: false,
    blockingBusy: false,
    importBusy: false,
    selectedBatchActive: false,
    tasks: [],
    linkedSeriesBookIds: new Set(),
    sources: [
      {
        id: sourceId,
        title: '테스트 소스',
        kind: 'catalog',
        origin: 'plugin',
        connection: { state: 'connected' },
        supportsSubscriptions: true,
      },
    ],
    activeSourceId: sourceId,
    items: [],
    query: '',
    stale: false,
    filterValues: {},
    breadcrumbs: [{ label: '전체' }],
    currentFolderIsDefault: false,
    currentLocationCanBeDefault: false,
    canPickItems: true,
    canRemoveItems: false,
    subscriptions: [],
    libraryWorks: [],
    checkingSubscriptions: false,
    canSubscribeCurrentWork: false,
    canQueueItem: vi.fn(() => false),
    canStreamItem: vi.fn(() => false),
    isWorkInLibrary: vi.fn(() => false),
    addWorkToLibrary: vi.fn().mockResolvedValue(undefined),
    addCurrentWorkToLibrary: vi.fn().mockResolvedValue(undefined),
    removeLibraryWork: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    showLocalSeries: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    selectSource: vi.fn().mockResolvedValue(undefined),
    setQuery: vi.fn(),
    search: vi.fn().mockResolvedValue(undefined),
    setBrowseMode: vi.fn().mockResolvedValue(undefined),
    openCatalogBrowse: vi.fn().mockResolvedValue(undefined),
    setFilterValue: vi.fn(),
    applyFilters: vi.fn().mockResolvedValue(undefined),
    resetFilters: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    toggleItem: vi.fn(),
    selectAllSupported: vi.fn(),
    importItem: vi.fn().mockResolvedValue(undefined),
    importAndOpen: vi.fn().mockResolvedValue(undefined),
    importSelected: vi.fn().mockResolvedValue(undefined),
    deleteDownloads: vi.fn().mockResolvedValue(undefined),
    openImported: vi.fn().mockResolvedValue(undefined),
    dismissTask: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    openItem: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    setCurrentFolderAsDefault: vi.fn().mockResolvedValue(undefined),
    clearDefaultFolder: vi.fn().mockResolvedValue(undefined),
    pickItems: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    subscribeCurrentWork: vi.fn().mockResolvedValue(undefined),
    unsubscribeCurrentWork: vi.fn().mockResolvedValue(undefined),
    acknowledgeNewReleases: vi.fn().mockResolvedValue(undefined),
    selectNewReleases: vi.fn(),
    checkSubscriptions: vi.fn().mockResolvedValue(undefined),
    continueLibraryWork: vi.fn().mockResolvedValue(undefined),
    openSubscription: vi.fn().mockResolvedValue(undefined),
    renameRelease: vi.fn().mockResolvedValue(undefined),
    setReleasesRead: vi.fn().mockResolvedValue(undefined),
    markPreviousReleasesRead: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTranslatedTitle).mockImplementation((title) => title);
  vi.stubGlobal('document', { activeElement: null, documentElement: { style: { overflow: '' } }, body: {} });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  c = controller();
  props = {
    controller: c,
    library: { model: model([]), actions: actions() },
    openSourceSettings: vi.fn(),
    openLocalSeriesImport: vi.fn(),
    localSeriesTitleEditor: {
      editing: false,
      draft: '로컬 작품',
      start: vi.fn(),
      cancel: vi.fn(),
      setDraft: vi.fn(),
      save: vi.fn(),
    },
  };
  hub = {
    controller: c,
    primaryRead: undefined,
    primaryReadFor: vi.fn(),
    streamNavigation: { busy: false, nextItem: undefined, previous: undefined, next: undefined },
    scrollRef: { current: null },
    workLayout: 'grid',
    changeWorkLayout: vi.fn(),
    taskByItemKey: new Map(),
    seriesNovel: undefined,
    readingActionLabel: undefined,
    activeSource: c.sources[0],
    folders: [],
    contentItems: [],
    selectableItems: [],
    selectedCount: 0,
    selectedDownloadCount: 0,
    selectedDownloaded: [],
    updateCount: 0,
    selectedUpdateCount: 0,
    allSelected: false,
    releaseList: false,
    releaseLocationKey: 'fixture-detail',
    hasWorkHero: false,
    connected: true,
    workTitle: '테스트 작품',
    workByline: '테스트 작가',
    workTags: ['판타지'],
    workSourceLabel: '테스트 소스',
    seriesLibraryBook: undefined,
    seriesReadingStatus: undefined,
    seriesCanContinue: false,
    localArchiveFormat: undefined,
    sourceSubscriptions: [],
    submitSearch: vi.fn(),
    streamReaderProps: undefined,
    itemActions: (item) => sourceHubItemActions(item, c),
    commands: {
      continueReading: vi.fn(),
      back: vi.fn(),
      goBack: vi.fn(),
      toggleDefaultFolder: vi.fn(),
      toggleFavorite: vi.fn(),
      editMetadata: vi.fn(),
      importLocalReleases: vi.fn(),
      deleteSelectedDownloads: vi.fn(),
      retryList: vi.fn(),
      search: vi.fn(),
      refresh: vi.fn(),
      importSelected: vi.fn(),
      pickItems: vi.fn(),
      checkSubscriptions: vi.fn(),
      addCurrentWorkToLibrary: vi.fn(),
      loadMore: vi.fn(),
      resetFilters: vi.fn(),
      applyFilters: vi.fn(),
      close: vi.fn(),
      cancel: vi.fn(),
      setQuery: vi.fn(),
      setBrowseMode: vi.fn().mockResolvedValue(undefined),
      setFilterValue: vi.fn(),
      selectAllSupported: vi.fn(),
      toggleItem: vi.fn(),
      openFolder: vi.fn().mockResolvedValue(undefined),
      openSubscription: vi.fn().mockResolvedValue(undefined),
      openSourceSettings: vi.fn(),
      saveDiscoveryList: vi.fn(),
      titleEditor: props.localSeriesTitleEditor,
    },
  };
  list = {
    query: '',
    setQuery: vi.fn(),
    readFilter: 'all',
    setReadFilter: vi.fn(),
    sort: 'asc',
    setSort: vi.fn(),
    sorted: [],
    requestedPage: 1,
    setRequestedPage: vi.fn(),
    page: paginateReleases([], 1),
    cursor: undefined,
    partial: false,
    selectable: [],
    selectedHere: 0,
    selectedTotal: 0,
    selectionRef: { current: null },
    changeQuery: vi.fn(),
    changeFilter: vi.fn(),
    changeSort: vi.fn(),
    reset: vi.fn(),
    selectPage: vi.fn(),
    setSelectedRead: vi.fn(),
    loadMore: vi.fn(),
    retryList: vi.fn(),
  };
  vi.mocked(useSourceHubModel).mockImplementation(() => hub);
  vi.mocked(useSourceReleaseList).mockImplementation(() => list);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function patch(patch: Partial<ExternalSourceController>) {
  c = { ...c, ...patch };
  hub.controller = c;
  props = { ...props, controller: c };
}
function file(overrides: Partial<ExternalSourceItemView> = {}): ExternalSourceItemView {
  return { ...episode(), title: '테스트 파일', release: undefined, collection: undefined, ...overrides };
}
function setItems(items: ExternalSourceItemView[]) {
  patch({ items });
  hub.contentItems = items;
  hub.selectableItems = items.filter(canSelectItem);
}
function releases(items: ExternalSourceItemView[] = [episode()]) {
  setItems(items);
  hub.releaseList = true;
  hub.hasWorkHero = true;
  list.sorted = items;
  list.page = paginateReleases(items, 1);
  list.selectable = items.filter(canSelectItem);
}
function localWork(totalChapters = 3) {
  releases();
  hub.seriesNovel = novel({ title: hub.workTitle, format: 'txt', totalChapters });
}
function task(phase: ImportTaskView['phase']): ImportTaskView {
  return { id: 'task-1', batchId: 'batch-1', source: 'external_source', title: '다운로드 작업', phase, percent: 45 };
}
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
function checkbox(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'label' && text(node).trim() === label).findByType('input');
}
function mount() {
  act(() => {
    renderer = create(<UiNextSourceHubScreen {...props} />);
  });
  return renderer!.root;
}
function sheet(root: ReactTestInstance) {
  return root.findByProps({ role: 'dialog' });
}
function releaseRow(root: ReactTestInstance, item = episode()) {
  return button(root, new RegExp(`^${item.title}, `));
}
function batch(root: ReactTestInstance) {
  return root.findByProps({ className: 'un-select-bar un-source-batch' });
}

describe('routing and catalog header', () => {
  it('renders SourceStreamReader with model props before source availability checks', () => {
    hub.activeSource = undefined;
    hub.connected = false;
    hub.streamReaderProps = {
      title: '스트리밍 작품',
      remoteId: 'stream-1',
      port: { kind: 'text', open: vi.fn() },
      onClose: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
    };
    const root = mount();
    expect(root.findByType(SourceStreamReader).props).toEqual(hub.streamReaderProps);
    expect(root.findAllByType('header')).toHaveLength(0);
  });
  it.each(['missing', 'disconnected'] as const)('renders null for a %s source without a local series', (state) => {
    if (state === 'missing') hub.activeSource = undefined;
    else hub.connected = false;
    mount();
    expect(renderer!.toJSON()).toBeNull();
  });
  it('keeps local series accessible without a connected source', () => {
    localWork();
    hub.activeSource = undefined;
    hub.connected = false;
    expect(text(mount())).toContain(hub.workTitle);
  });
  it.each([1, 2])('routes back with %s breadcrumbs', (depth) => {
    patch({ breadcrumbs: [{ label: '전체' }, { label: '하위', parentRef: 'nested' }].slice(0, depth) });
    click(button(mount(), depth > 1 ? '상위 폴더' : '닫기'));
    expect(hub.commands[depth > 1 ? 'goBack' : 'close']).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([true, false])('offers file picking only when canPickItems=%s', (canPickItems) => {
    patch({ canPickItems });
    const root = mount();
    const choices = root.findAllByType('button').filter((node) => text(node) === '파일 추가');
    expect(choices).toHaveLength(canPickItems ? 1 : 0);
    if (canPickItems) {
      click(choices[0]);
      expect(hub.commands.pickItems).toHaveBeenCalledExactlyOnceWith();
    }
  });
  it.each([
    ['새로고침', 'refresh'],
    ['소스 관리', 'openSourceSettings'],
  ] as const)('routes %s through commands.%s', (label, command) => {
    click(button(mount(), label));
    expect(hub.commands[command]).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('catalog navigation and filters', () => {
  it('opens a saved work and checks for new releases', () => {
    const subscription: Hub['sourceSubscriptions'][number] = {
      id: 'subscription-1',
      connectorId: sourceId,
      collectionRemoteId: 'work',
      navigationRef: 'work-ref',
      title: '구독 작품',
      knownReleaseIds: [],
      newReleaseIds: ['new'],
      availableReleaseCount: 4,
      lastCheckedAt: '2026-07-01',
      createdAt: '2026-07-01',
      updatedAt: '2026-07-01',
      schemaVersion: 1,
    };
    hub.sourceSubscriptions = [subscription];
    const root = mount();
    const subscriptions = root.findByProps({ 'aria-label': '서재에 추가한 작품' });
    click(button(subscriptions, /^구독 작품/));
    expect(hub.commands.openSubscription).toHaveBeenCalledExactlyOnceWith(subscription);
    click(button(subscriptions, '새 회차 확인'));
    expect(hub.commands.checkSubscriptions).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([false, true])('shows breadcrumbs and toggles the default folder (current=%s)', (currentFolderIsDefault) => {
    patch({
      breadcrumbs: [{ label: '전체' }, { label: '소설 폴더', parentRef: 'folder' }],
      currentLocationCanBeDefault: true,
      currentFolderIsDefault,
    });
    const root = mount();
    expect(text(root.findByProps({ 'aria-label': '현재 외부 소스 위치' }))).toContain('소설 폴더');
    click(button(root, currentFolderIsDefault ? '기본 폴더 해제' : '현재 폴더를 기본 폴더로 설정'));
    expect(hub.commands.toggleDefaultFolder).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([
    ['인기', 'popular'],
    ['최신', 'latest'],
  ] as const)('selects the %s mode', (label, mode) => {
    patch({ browse: { activeMode: 'popular', availableModes: ['popular', 'latest', 'search'] } });
    click(button(mount(), label));
    expect(hub.commands.setBrowseMode).toHaveBeenCalledExactlyOnceWith(mode);
  });
  it('opens filters, forwards field changes/reset, then applies and closes the real sheet', () => {
    patch({
      browse: {
        activeMode: 'popular',
        availableModes: ['popular', 'search'],
        filters: [
          { id: 'genre', position: 0, kind: 'select', label: '장르', options: ['전체', '판타지'], defaultValue: 0 },
        ],
      },
    });
    const root = mount();
    click(button(root, '필터'));
    const dialog = sheet(root);
    act(() => dialog.findByType('select').props.onChange({ target: { value: '1' } }));
    expect(hub.commands.setFilterValue).toHaveBeenCalledExactlyOnceWith('genre', 1);
    click(button(dialog, '초기화'));
    expect(hub.commands.resetFilters).toHaveBeenCalledExactlyOnceWith();
    click(button(dialog, '적용'));
    expect(hub.commands.applyFilters).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
  it('adds the current list to discovery when the capability exists', () => {
    patch({ browse: { activeMode: 'popular', availableModes: ['popular'] } });
    props.library.actions.header.saveDiscoveryList = vi.fn();
    click(button(mount(), '탐색에 추가'));
    expect(hub.commands.saveDiscoveryList).toHaveBeenCalledExactlyOnceWith();
  });
  it('announces remote updates', () => {
    hub.updateCount = 2;
    const root = mount();
    expect(text(root.findByProps({ role: 'status' }))).toContain('2개 작품에 원격 업데이트가 있어요');
  });
  it('opens folders and submits catalog search', () => {
    const folder = file({ kind: 'folder', title: '폴더', navigationRef: 'folder-ref' });
    hub.folders = [folder];
    const root = mount();
    click(button(root, '폴더'));
    expect(hub.commands.openFolder).toHaveBeenCalledExactlyOnceWith(folder);
    act(() => root.findByProps({ 'aria-label': '작품 검색' }).props.onChange({ target: { value: '검색어' } }));
    expect(hub.commands.setQuery).toHaveBeenCalledExactlyOnceWith('검색어');
    const event = { preventDefault: vi.fn() };
    act(() => root.findByProps({ role: 'search' }).props.onSubmit(event));
    expect(hub.submitSearch).toHaveBeenCalledExactlyOnceWith(event);
  });
});

describe('catalog items and loading', () => {
  it('opens work posters, adds a work, and shows already-added badges', () => {
    const available = file({ kind: 'work', title: '새 작품', navigationRef: 'work-ref' });
    const owned = file({
      key: { ...available.key, remoteId: 'owned' },
      kind: 'work',
      title: '기존 작품',
      navigationRef: 'owned-ref',
    });
    setItems([available, owned]);
    vi.mocked(c.isWorkInLibrary).mockImplementation((item) => item === owned);
    const root = mount();
    click(button(root, '새 작품 작품 상세 열기'));
    expect(c.openItem).toHaveBeenCalledExactlyOnceWith(available);
    click(button(root, '새 작품 라이브러리 추가'));
    expect(c.addWorkToLibrary).toHaveBeenCalledExactlyOnceWith(available);
    const card = button(root, '기존 작품 작품 상세 열기');
    expect(text(card)).toContain('추가됨');
    expect(root.findAllByProps({ 'aria-label': '기존 작품 라이브러리 추가' })).toHaveLength(0);
  });

  it.each([
    ['available', undefined, '가져오기', 'importItem'],
    ['imported', 'saved', '열기', 'openImported'],
    ['update_available', undefined, '업데이트', 'importItem'],
  ] as const)('routes file %s (local=%s, button=%s) through %s', (importState, localBookId, label, command) => {
    const item = file({ importState, localBookId });
    setItems([item]);
    click(button(mount(), label));
    expect(c[command]).toHaveBeenCalledExactlyOnceWith(item);
  });

  it('toggles file selection by its external key', () => {
    const item = file({ selected: true });
    setItems([item]);
    const root = mount();
    const input = root.findByProps({ 'aria-label': `${item.title} 선택` });
    expect(input.props.checked).toBe(true);
    act(() => input.props.onChange({ target: { checked: false } }));
    expect(c.toggleItem).toHaveBeenCalledExactlyOnceWith(externalItemKeyId(item.key));
  });

  it.each([true, false])('offers item removal only when canRemoveItems=%s', (canRemoveItems) => {
    const item = file();
    setItems([item]);
    patch({ canRemoveItems });
    const root = mount();
    const remove = root.findAllByProps({ 'aria-label': `${item.title} 선택 목록에서 제거` });
    expect(remove).toHaveLength(canRemoveItems ? 1 : 0);
    if (canRemoveItems) {
      click(remove[0]);
      expect(c.removeItem).toHaveBeenCalledExactlyOnceWith(item);
    }
  });

  it('shows skeletons while loading an empty catalog', () => {
    patch({ loading: true });
    const root = mount();
    const status = root.findByProps({ role: 'status', 'aria-label': '목록을 불러오고 있어요' });
    expect(root.findByProps({ 'aria-busy': true })).toBeDefined();
    expect(status.findAllByProps({ className: 'un-skeleton' }).length).toBeGreaterThan(0);
  });

  it.each([false, true])('explains an empty page with a search cursor=%s', (hasCursor) => {
    patch({ query: hasCursor ? '없는 작품' : '', nextCursor: hasCursor ? 'next' : undefined });
    const root = mount();
    expect(text(root)).toContain(hasCursor ? '이 페이지에는 검색 결과가 없어요' : '표시할 파일이나 작품이 없어요');
  });

  it('shows list errors and retries through commands.retryList', () => {
    patch({ listError: { message: '연결 실패', retry: vi.fn().mockResolvedValue(undefined) } });
    const root = mount();
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('연결 실패');
    click(button(alert, '다시 불러오기'));
    expect(hub.commands.retryList).toHaveBeenCalledExactlyOnceWith();
  });

  it('loads additional catalog pages', () => {
    patch({ nextCursor: 'next' });
    click(button(mount(), '더 보기'));
    expect(hub.commands.loadMore).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('work hero and title editing', () => {
  it('routes the work back button to commands.back', () => {
    localWork();
    click(button(mount(), '뒤로'));
    expect(hub.commands.back).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    // The local work is a TXT novel, so the verb is 읽기.
    [false, false, 3, '첫 회차 읽기', false],
    [false, true, 3, '이어 읽기', false],
    [true, false, 0, '이어 읽기', false],
    [false, false, 0, '다운로드한 회차 없음', true],
  ] as const)(
    'uses the read label for resume=%s, continue=%s, count=%s',
    (resume, continuing, count, label, disabled) => {
      localWork(count);
      patch({ canResumeCurrentWork: resume });
      hub.seriesCanContinue = continuing;
      const root = mount();
      const read = button(root, label);
      expect(read.props.disabled).toBe(disabled);
      if (!disabled) {
        click(read);
        expect(hub.commands.continueReading).toHaveBeenCalledExactlyOnceWith();
      }
    },
  );

  it('adds an unsubscribed work to the library', () => {
    releases();
    patch({ canSubscribeCurrentWork: true });
    click(button(mount(), '서재에 추가'));
    expect(hub.commands.addCurrentWorkToLibrary).toHaveBeenCalledExactlyOnceWith();
  });

  it('offers new episodes instead of the library for a work already on the shelf', () => {
    localWork(3);
    patch({ canSubscribeCurrentWork: true });
    click(button(mount(), '새 회차 받기'));
    expect(hub.commands.addCurrentWorkToLibrary).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, true])('exposes favorite=%s and toggles it', (favorite) => {
    localWork();
    hub.seriesNovel = { ...hub.seriesNovel!, favorite };
    const root = mount();
    const toggle = button(root, '즐겨찾기');
    expect(toggle.props['aria-pressed']).toBe(favorite);
    click(toggle);
    expect(hub.commands.toggleFavorite).toHaveBeenCalledExactlyOnceWith();
  });

  it('imports local releases from the more sheet', () => {
    localWork();
    const root = mount();
    expect(root.findAllByProps({ 'aria-label': '로컬 회차 추가' })).toHaveLength(0);
    click(button(root, '더보기'));
    click(button(sheet(root), '로컬 회차 추가'));
    expect(hub.commands.importLocalReleases).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('opens metadata editing from the work hero', () => {
    localWork();
    const root = mount();
    click(button(root.findByProps({ className: 'un-detail-hero' }), '작품 정보 편집'));
    expect(hub.commands.editMetadata).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each(['busy', 'loading'] as const)('disables metadata editing while %s', (state) => {
    localWork();
    patch({ [state]: true });
    expect(button(mount().findByProps({ className: 'un-detail-hero' }), '작품 정보 편집').props.disabled).toBe(true);
    expect(hub.commands.editMetadata).not.toHaveBeenCalled();
  });

  it('keeps metadata editing available without local chapter import', () => {
    localWork();
    props = { ...props, openLocalSeriesImport: undefined };
    const root = mount();
    click(button(root.findByProps({ className: 'un-detail-hero' }), '작품 정보 편집'));
    expect(hub.commands.editMetadata).toHaveBeenCalledExactlyOnceWith();
    click(button(root, '더보기'));
    expect(
      sheet(root)
        .findAllByType('button')
        .filter((node) => text(node) === '로컬 회차 추가'),
    ).toHaveLength(0);
    expect(hub.commands.importLocalReleases).not.toHaveBeenCalled();
  });

  it.each([false, true])('routes title editing from the more sheet (editing=%s)', (editing) => {
    localWork();
    props = { ...props, localSeriesTitleEditor: { ...props.localSeriesTitleEditor!, editing } };
    const root = mount();
    click(button(root, '더보기'));
    click(button(sheet(root), editing ? '제목 수정 취소' : '제목 빠르게 고치기'));
    expect(props.localSeriesTitleEditor![editing ? 'cancel' : 'start']).toHaveBeenCalledExactlyOnceWith();
  });

  it('sends title input, Escape, and form submission to the editor', () => {
    localWork();
    const editor = { ...props.localSeriesTitleEditor!, editing: true, draft: '기존 제목' };
    props = { ...props, localSeriesTitleEditor: editor };
    const root = mount();
    const input = root.findByProps({ 'aria-label': '책 제목' });
    expect(input.props.value).toBe('기존 제목');
    act(() => input.props.onChange({ target: { value: '새 제목' } }));
    expect(editor.setDraft).toHaveBeenCalledExactlyOnceWith('새 제목');
    const preventDefault = vi.fn();
    act(() => input.props.onKeyDown({ key: 'Escape', preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(editor.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(button(root, '책 제목 저장').props.type).toBe('submit');
    act(() => root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    expect(editor.save).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('source primary read and opening feedback', () => {
  it.each([
    ['first', '6화'],
    ['first', '새로운 장면'],
    ['continue', '6화'],
    ['continue', '새로운 장면'],
  ] as const)('renders %s episode CTA with title %s and runs primaryRead', async (kind, episodeTitle) => {
    releases();
    const run = vi.fn().mockResolvedValue(undefined);
    hub.primaryRead = { kind, episodeNumber: 6, episodeTitle, item: episode('six'), busy: false, run };
    const root = mount();
    const label = root.findByProps({ className: 'un-detail-read-label' });
    expect(label.children[0]).toBe(kind === 'first' ? '6화 보기' : '6화 이어 보기');
    const subtitle = label.findAllByType('small');
    expect(subtitle).toHaveLength(kind === 'continue' && episodeTitle !== '6화' ? 1 : 0);
    if (subtitle.length) expect(text(subtitle[0])).toBe(episodeTitle);
    await clickAsync(label.parent!);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    expect(hub.commands.continueReading).not.toHaveBeenCalled();
  });

  it.each([false, true])('shows the primary read opening spinner and aria-busy only while opening=%s', (opening) => {
    releases();
    const item = episode('six');
    patch({ openingItemKey: opening ? externalItemKeyId(item.key) : undefined });
    const run = vi.fn().mockResolvedValue(undefined);
    hub.primaryRead = { kind: 'continue', episodeNumber: 6, episodeTitle: '6화', item, busy: opening, run };
    const root = mount();
    const read = root.findByProps({ className: 'un-detail-read-label' }).parent!;
    expect(read.props['aria-busy']).toBe(opening);
    expect(read.props.disabled).toBe(opening);
    const icon = read.findByType('svg');
    expect(icon.props.className).toContain(opening ? 'lucide-loader-circle' : 'lucide-play');
    expect(icon.props.className.includes('un-spin')).toBe(opening);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['1화', 0, undefined, 1],
    ['6화', 5, undefined, 6],
    ['다른 장면', 7, 99, 7],
    ['외전', undefined, 9, 9],
  ] as const)(
    'shows the source episode number for title=%s raw=%s order=%s',
    (title, chapterNumber, sourceOrder, expected) => {
      const item = { ...episode(), title, release: { title, chapterNumber, sourceOrder } };
      releases([item]);
      const root = mount();
      expect(text(releaseRow(root, item).findByProps({ className: 'un-chapter-index' }))).toBe(String(expected));
    },
  );

  it('keeps fallback episode numbering global across pages', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...episode(String(index)),
      title: `제목-${index}`,
      release: { title: '번호 없는 제목' },
    }));
    releases(items);
    list.page = paginateReleases(items, 2);
    const root = mount();
    expect(text(releaseRow(root, items[10]).findByProps({ className: 'un-chapter-index' }))).toBe('11');
  });

  it('marks only the opening row and clears its spinner when opening completes', () => {
    const items = [episode('one'), episode('two')];
    releases(items);
    patch({ openingItemKey: externalItemKeyId(items[1].key) });
    const root = mount();
    const first = releaseRow(root, items[0]);
    const opening = releaseRow(root, items[1]);
    expect(first.parent!.props.className.split(' ')).not.toContain('is-opening');
    expect(opening.parent!.props.className.split(' ')).toContain('is-opening');
    expect(text(first)).not.toContain('여는 중');
    expect(text(opening)).toContain('여는 중');
    expect(opening.findByType('svg').props.className).toContain('lucide-loader-circle');
    patch({ openingItemKey: undefined });
    act(() => renderer!.update(<UiNextSourceHubScreen {...props} />));
    expect(opening.parent!.props.className.split(' ')).not.toContain('is-opening');
    expect(text(opening)).not.toContain('여는 중');
    expect(opening.findAllByType('svg')).toHaveLength(0);
  });
});

describe('release list controls and reading', () => {
  it('routes search input to changeQuery', () => {
    releases();
    const root = mount();
    act(() => root.findByProps({ 'aria-label': '회차 검색' }).props.onChange({ target: { value: '3화' } }));
    expect(list.changeQuery).toHaveBeenCalledExactlyOnceWith('3화');
  });
  it.each([
    ['전체', 'all'],
    ['안 읽음', 'unread'],
    ['읽음', 'read'],
  ] as const)('selects the %s filter', (label, value) => {
    releases();
    const root = mount();
    click(button(root.findByProps({ role: 'radiogroup', 'aria-label': '읽음 상태 필터' }), label));
    expect(list.changeFilter).toHaveBeenCalledExactlyOnceWith(value);
  });
  it.each([
    ['asc', 'desc', '처음 화부터'],
    ['desc', 'asc', '최신 화부터'],
  ] as const)('toggles sorting %s to %s', (sort, next, label) => {
    releases();
    list.sort = sort;
    click(button(mount(), label));
    expect(list.changeSort).toHaveBeenCalledExactlyOnceWith(next);
  });
  it.each([false, true])('selects the current page with checked=%s', (checked) => {
    releases();
    const root = mount();
    click(button(root, '선택'));
    const input = checkbox(root, '이 페이지 전체');
    expect(input.props.disabled).toBe(false);
    act(() => input.props.onChange({ target: { checked } }));
    expect(list.selectPage).toHaveBeenCalledExactlyOnceWith(checked);
  });
  it('opens a downloaded current release through the saved read action', () => {
    const item = {
      ...episode(),
      importState: 'imported' as const,
      localBookId: 'saved',
      readingState: 'current' as const,
    };
    releases([item]);
    const root = mount();
    expect(root.findByProps({ 'aria-current': 'location' }).type).toBe('li');
    click(releaseRow(root, item));
    expect(c.openImported).toHaveBeenCalledExactlyOnceWith(item);
    expect(c.importAndOpen).not.toHaveBeenCalled();
  });
  it('streams a readable remote release when no downloaded book exists', () => {
    const item = episode();
    releases([item]);
    patch({ canStreamItem: vi.fn(() => true) });
    click(releaseRow(mount(), item));
    expect(c.importAndOpen).toHaveBeenCalledExactlyOnceWith(item);
    expect(c.openImported).not.toHaveBeenCalled();
  });
  it('keeps a non-readable and non-streamable row disabled', () => {
    releases();
    expect(releaseRow(mount()).props.disabled).toBe(true);
  });
});

describe('release selection mode', () => {
  it('shows row and page checkboxes only after pressing selection', () => {
    const items = [episode('one'), episode('two')];
    releases(items);
    const root = mount();
    expect(root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    click(button(root, '선택'));
    expect(root.findAllByProps({ type: 'checkbox' })).toHaveLength(3);
    expect(checkbox(root, '이 페이지 전체').props.checked).toBe(false);
    for (const item of items)
      expect(root.findByProps({ 'aria-label': `${item.title} 선택` }).props.checked).toBe(false);
    act(() => root.findByProps({ 'aria-label': `${items[0].title} 선택` }).props.onChange());
    expect(c.toggleItem).toHaveBeenCalledExactlyOnceWith(externalItemKeyId(items[0].key));
  });

  it('finishes explicit selection mode and clears selection before returning to normal rows', () => {
    const item = episode();
    releases([item]);
    const root = mount();
    click(button(root, '선택'));
    releases([{ ...item, selected: true }]);
    hub.selectedCount = 1;
    list.selectedHere = 1;
    list.selectedTotal = 1;
    act(() => renderer!.update(<UiNextSourceHubScreen {...props} />));
    click(button(root, '완료'));
    expect(c.selectAllSupported).toHaveBeenCalledExactlyOnceWith(false);
    // The controller owns the selection; finish takes effect once its cleared model arrives.
    releases([{ ...item, selected: false }]);
    hub.selectedCount = 0;
    list.selectedHere = 0;
    list.selectedTotal = 0;
    act(() => renderer!.update(<UiNextSourceHubScreen {...props} />));
    expect(root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    expect(button(root, '선택')).toBeDefined();
    expect(root.findAllByProps({ className: 'un-select-bar un-source-batch' })).toHaveLength(0);
  });

  it('keeps selection mode active while the model has a selection without an explicit request', () => {
    const item = { ...episode(), selected: true };
    releases([item]);
    hub.selectedCount = 1;
    list.selectedHere = 1;
    list.selectedTotal = 1;
    const root = mount();
    expect(root.findByProps({ 'aria-label': `${item.title} 선택` }).props.checked).toBe(true);
    expect(checkbox(root, '이 페이지 전체').props.checked).toBe(true);
    click(button(root, '완료'));
    expect(c.selectAllSupported).toHaveBeenCalledExactlyOnceWith(false);
    expect(root.findByProps({ 'aria-label': `${item.title} 선택` }).props.checked).toBe(true);
    expect(button(root, '완료')).toBeDefined();
  });

  it.each(['downloaded', 'streamable', 'not-readable'] as const)(
    'toggles a %s release on row tap instead of opening it in selection mode',
    (kind) => {
      const item =
        kind === 'downloaded' ? { ...episode(), importState: 'imported' as const, localBookId: 'saved' } : episode();
      releases([item]);
      if (kind === 'streamable') patch({ canStreamItem: vi.fn(() => true) });
      const root = mount();
      expect(releaseRow(root, item).props.disabled).toBe(kind === 'not-readable');
      click(button(root, '선택'));
      click(releaseRow(root, item));
      expect(c.toggleItem).toHaveBeenCalledExactlyOnceWith(externalItemKeyId(item.key));
      expect(c.openImported).not.toHaveBeenCalled();
      expect(c.importAndOpen).not.toHaveBeenCalled();
    },
  );
});

describe('release download icons and commands', () => {
  it.each(['progress', 'retry', 'delete', 'update', 'read', 'download', 'unsupported'] as const)(
    'renders and executes the %s download state',
    (state) => {
      let item = episode();
      if (state === 'delete') item = { ...item, importState: 'imported', localBookId: 'saved' };
      if (state === 'update') item = { ...item, importState: 'update_available' };
      if (state === 'unsupported') item = { ...item, importability: 'unsupported', importState: 'unsupported' };
      releases([item]);
      if (state === 'delete') patch({ renameRelease: undefined });
      if (state === 'read') patch({ canStreamItem: vi.fn(() => true) });
      if (state === 'progress' || state === 'retry')
        hub.taskByItemKey.set(externalItemKeyId(item.key), task(state === 'progress' ? 'downloading' : 'failed'));
      const labels = {
        progress: `${item.title} 다운로드 중단`,
        retry: `${item.title} 다시 시도`,
        delete: `${item.title} 다운로드 삭제`,
        update: `${item.title} 업데이트`,
        read: `${item.title} 바로 읽기`,
        download: `${item.title} 다운로드 후 보기`,
        unsupported: '지원하지 않음',
      };
      const icons = {
        progress: 'lucide-x',
        retry: 'lucide-rotate-ccw',
        delete: 'lucide-trash2',
        update: 'lucide-refresh-cw',
        read: 'lucide-play',
        download: 'lucide-download',
        unsupported: 'lucide-x',
      };
      const root = mount();
      const action = button(root, labels[state]);
      expect(action.findByType('svg').props.className).toContain(icons[state]);
      if (state === 'progress') {
        expect(action.findByProps({ className: 'un-ring' }).props.style['--un-ring']).toBe('45%');
        expect(root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(45);
      }
      if (state === 'unsupported') {
        expect(action.props.disabled).toBe(true);
        return;
      }
      click(action);
      if (state === 'progress') expect(c.cancel).toHaveBeenCalledExactlyOnceWith();
      else if (state === 'delete') expect(c.deleteDownloads).toHaveBeenCalledExactlyOnceWith([item]);
      else if (state === 'retry' || state === 'update') expect(c.importItem).toHaveBeenCalledExactlyOnceWith(item);
      else expect(c.importAndOpen).toHaveBeenCalledExactlyOnceWith(item);
    },
  );
  it('disables the cancel icon when a download is already cancelling', () => {
    releases();
    hub.taskByItemKey.set(externalItemKeyId(episode().key), task('cancelling'));
    expect(button(mount(), 'one 취소 중').props.disabled).toBe(true);
  });
});

describe('release action sheets', () => {
  it.each(['read', 'unread', 'previous', 'delete'] as const)('executes the %s menu action', async (action) => {
    const item = {
      ...episode(),
      importState: 'imported' as const,
      localBookId: 'saved',
      readingState: action === 'unread' ? ('read' as const) : ('unread' as const),
    };
    releases([item]);
    const root = mount();
    click(button(root, `${item.title} 더보기`));
    const labels = {
      read: '읽음으로 변경',
      unread: '안 읽음으로 변경',
      previous: '이전 회차 모두 읽음',
      delete: '다운로드 삭제',
    };
    await clickAsync(button(sheet(root), labels[action]));
    if (action === 'read' || action === 'unread')
      expect(c.setReleasesRead).toHaveBeenCalledExactlyOnceWith([item], action === 'read');
    else if (action === 'previous') expect(c.markPreviousReleasesRead).toHaveBeenCalledExactlyOnceWith(item);
    else expect(c.deleteDownloads).toHaveBeenCalledExactlyOnceWith([item]);
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
  it.each([false, true])('renames a release and reports failures (reject=%s)', async (reject) => {
    const item = episode();
    releases([item]);
    if (reject) patch({ renameRelease: vi.fn().mockRejectedValue(new Error('이름 저장 실패')) });
    const root = mount();
    click(button(root, `${item.title} 더보기`));
    click(button(sheet(root), '제목 수정'));
    const dialog = sheet(root);
    act(() => dialog.findByProps({ 'aria-label': '회차 제목' }).props.onChange({ target: { value: '새 회차 제목' } }));
    expect(button(dialog, '저장').props.type).toBe('submit');
    await act(async () => {
      dialog.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(c.renameRelease).toHaveBeenCalledExactlyOnceWith(item, '새 회차 제목');
    if (reject) expect(text(root.findByProps({ role: 'alert' }))).toBe('이름 저장 실패');
    else expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});

describe('release status, paging, and selection summary', () => {
  it('explains partial catalogs and offers loading more', () => {
    releases();
    list.partial = true;
    list.cursor = 'next';
    const root = mount();
    expect(text(root.findByProps({ role: 'status' }))).toContain('목차 일부만 불러왔어요.');
    click(button(root, '목차 더 불러오기'));
    expect(list.loadMore).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['loading', 'catalogLoading', 'deletingDownloads'] as const)('announces %s', (state) => {
    releases();
    patch({ [state]: true });
    const root = mount();
    const labels = {
      loading: '전체 목차를 준비하고 있어요',
      catalogLoading: '목차를 확인하는 중',
      deletingDownloads: '다운로드를 지우는 중',
    };
    expect(text(root.findByProps({ role: 'status' }))).toContain(labels[state]);
  });
  it('retries a release-list error through the release-list command', () => {
    releases();
    patch({ listError: { message: '목차 연결 실패', retry: vi.fn().mockResolvedValue(undefined) } });
    const root = mount();
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('목차 연결 실패');
    click(button(alert, '다시 불러오기'));
    expect(list.retryList).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([1, 2, 3])('shows page %s and routes previous/next to setRequestedPage', (page) => {
    const items = Array.from({ length: 25 }, (_, i) => episode(String(i + 1)));
    releases(items);
    list.page = paginateReleases(items, page);
    const root = mount();
    const pager = root.findByProps({ 'aria-label': '회차 페이지' });
    expect(text(pager.findByProps({ 'aria-current': 'page' }))).toBe(String(page));
    expect(button(pager, '이전 페이지').props.disabled).toBe(page === 1);
    expect(button(pager, '다음 페이지').props.disabled).toBe(page === 3);
    if (page > 1) {
      click(button(pager, '이전 페이지'));
      expect(list.setRequestedPage).toHaveBeenCalledWith(page - 1);
    }
    if (page < 3) {
      click(button(pager, '다음 페이지'));
      expect(list.setRequestedPage).toHaveBeenCalledWith(page + 1);
    }
  });
  it('routes selection summary read/unread and clear actions', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...episode(String(index + 1)),
      selected: index === 0 || index === 11,
    }));
    releases(items);
    hub.selectedCount = 2;
    list.selectedTotal = 2;
    list.selectedHere = 1;
    const root = mount();
    const bar = batch(root);
    expect(text(bar)).toContain('2개 선택');
    // Include the selected release outside the current page, excluding every unselected release.
    expect(list.page.items).not.toContain(items[11]);
    await clickAsync(button(bar, '읽음'));
    await clickAsync(button(bar, '안 읽음'));
    expect(c.setReleasesRead).toHaveBeenNthCalledWith(1, [items[0], items[11]], true);
    expect(c.setReleasesRead).toHaveBeenNthCalledWith(2, [items[0], items[11]], false);
    expect(c.setReleasesRead).toHaveBeenCalledTimes(2);
    expect(list.setSelectedRead).not.toHaveBeenCalled();
    click(button(root, '완료'));
    expect(c.selectAllSupported).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('offers clearing search and filters for empty release results', () => {
    releases([]);
    list.query = '없는 회차';
    const root = mount();
    expect(text(root)).toContain('맞는 회차가 없어요');
    click(button(root, '검색과 필터 지우기'));
    expect(list.reset).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('batch action bar', () => {
  it('shows batch progress and cancels the active download', () => {
    releases();
    patch({
      selectedBatchActive: true,
      importBusy: true,
      progress: { current: 2, total: 5, completed: 1, failed: 0, linkedExisting: 0 },
    });
    const root = mount();
    const bar = batch(root);
    expect(bar.props.role).toBe('status');
    expect(text(bar)).toContain('선택 회차 다운로드 중');
    expect(text(bar)).toContain('1/5');
    click(button(bar, '중단'));
    expect(hub.commands.cancel).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([
    [false, 2, 0, '가져오기'],
    [true, 2, 0, '다운로드'],
    [true, 2, 2, '업데이트'],
    [true, 2, 1, '가져오기·업데이트'],
  ] as const)(
    'labels selected downloads (releases=%s, downloads=%s, updates=%s) as %s',
    (releaseList, downloads, updates, label) => {
      if (releaseList) releases();
      hub.selectedCount = 2;
      hub.selectedDownloadCount = downloads;
      hub.selectedUpdateCount = updates;
      click(button(batch(mount()), label));
      expect(hub.commands.importSelected).toHaveBeenCalledExactlyOnceWith();
    },
  );
  it('deletes selected downloaded releases', () => {
    releases();
    hub.selectedCount = 1;
    hub.selectedDownloaded = [{ ...episode(), importState: 'imported', localBookId: 'saved', selected: true }];
    click(button(batch(mount()), '다운로드 삭제 1'));
    expect(hub.commands.deleteSelectedDownloads).toHaveBeenCalledExactlyOnceWith();
  });
  it('shows a translated source heading alongside its original without changing editing or source metadata', () => {
    localWork();
    hub.workTitle = 'An Original Work';
    patch({ detail: { title: 'An Original Work' } });
    vi.mocked(useTranslatedTitle).mockImplementation((title, visible) => (visible ? '번역한 작품' : title));
    const root = mount();
    expect(text(root.findByProps({ id: 'un-source-title' }))).toBe('번역한 작품');
    expect(
      root.findAllByProps({ className: 'un-detail-byline' }).some((node) => text(node) === 'An Original Work'),
    ).toBe(true);
    expect(c.detail?.title).toBe('An Original Work');
    expect(props.localSeriesTitleEditor?.draft).toBe('로컬 작품');
  });
});
