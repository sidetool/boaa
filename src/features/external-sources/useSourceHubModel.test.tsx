import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { useSourceHubModel } from './useSourceHubModel';
import type { SourceHubScreenProps } from './source-hub-contract';
function SourceHubScreen(props: SourceHubScreenProps) {
  const model = useSourceHubModel(props);
  return model.streamReaderProps ? <SourceStreamReader {...model.streamReaderProps} /> : null;
}
import { SourceStreamReader } from './SourceStreamReader';
vi.mock('./SourceStreamReader', () => ({ SourceStreamReader: () => null }));
import type { ExternalSourceController } from './useExternalSourceController';

function controller(overrides: Partial<ExternalSourceController> = {}): ExternalSourceController {
  return {
    open: true,
    loading: false,
    busy: false,
    blockingBusy: false,
    importBusy: false,
    selectedBatchActive: false,
    tasks: [],
    sources: [
      {
        id: 'fixture.source',
        title: '개발용 작품 소스',
        kind: 'catalog',
        origin: 'plugin',
        connection: { state: 'connected', label: '개발 연결' },
      },
    ],
    activeSourceId: 'fixture.source',
    items: [
      {
        key: { connectorId: 'fixture.source', remoteId: 'work-1' },
        kind: 'work',
        title: '외부 작품',
        importFileName: '외부 작품.txt',
        author: '테스트 작가',
        formatHint: 'TXT',
        byteLength: 1024,
        updatedAt: '2026-08-23T00:00:00.000Z',
        importability: 'supported',
        selected: false,
        importState: 'available',
      },
    ],
    query: '',
    stale: false,
    detail: undefined,
    localSeriesSourceId: undefined,
    browse: undefined,
    filterValues: {},
    breadcrumbs: [{ label: '전체' }],
    currentFolderIsDefault: false,
    currentLocationCanBeDefault: false,
    canPickItems: false,
    canRemoveItems: false,
    subscriptions: [],
    libraryWorks: [],
    linkedSeriesBookIds: new Set(),
    activeSubscription: undefined,
    checkingSubscriptions: false,
    canSubscribeCurrentWork: false,
    canQueueItem: vi.fn(() => false),
    isWorkInLibrary: vi.fn(() => false),
    addWorkToLibrary: vi.fn(async () => undefined),
    addCurrentWorkToLibrary: vi.fn(async () => undefined),
    removeLibraryWork: vi.fn(async () => undefined),
    show: vi.fn(),
    showLocalSeries: vi.fn(async () => undefined),
    close: vi.fn(),
    selectSource: vi.fn(async () => undefined),
    setQuery: vi.fn(),
    search: vi.fn(async () => undefined),
    setBrowseMode: vi.fn(async () => undefined),
    openCatalogBrowse: vi.fn(async () => undefined),
    setFilterValue: vi.fn(),
    applyFilters: vi.fn(async () => undefined),
    resetFilters: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    toggleItem: vi.fn(),
    selectAllSupported: vi.fn(),
    importItem: vi.fn(async () => undefined),
    importAndOpen: vi.fn(async () => undefined),
    importSelected: vi.fn(async () => undefined),
    deleteDownloads: vi.fn(async () => undefined),
    openImported: vi.fn(async () => undefined),
    dismissTask: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    openItem: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    setCurrentFolderAsDefault: vi.fn(async () => undefined),
    clearDefaultFolder: vi.fn(async () => undefined),
    pickItems: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    subscribeCurrentWork: vi.fn(async () => undefined),
    unsubscribeCurrentWork: vi.fn(async () => undefined),
    acknowledgeNewReleases: vi.fn(async () => undefined),
    selectNewReleases: vi.fn(),
    checkSubscriptions: vi.fn(async () => undefined),
    openSubscription: vi.fn(async () => undefined),
    continueLibraryWork: vi.fn(async () => undefined),
    ...overrides,
  };
}

const library = {
  model: {
    query: '',
    filter: 'all',
    sort: 'recent',
    viewMode: 'grid',
    sync: { label: '연결 안 됨', tone: 'local' },
    externalSources: {
      active: true,
      activeSourceId: 'fixture.source',
      busy: false,
      sources: [{ id: 'fixture.source', title: '개발용 작품 소스', kind: 'catalog' }],
    },
    collection: {
      filterCounts: { all: 0, reading: 0, finished: 0, unread: 0, favorite: 0, trash: 0 },
    },
    presentation: { shelfBookCounts: new Map() },
    management: { available: false, shelves: [], selectionMode: false, selectedBookIds: new Set(), busy: false },
  },
  actions: {
    presentation: { goHome: vi.fn() },
    controls: { setFilter: vi.fn(), setShelf: vi.fn() },
    books: { continueReading: vi.fn(), toggleFavorite: vi.fn(), editMetadata: vi.fn() },
    header: {
      setQuery: vi.fn(),
      openImport: vi.fn(),
      openLibraryFolders: vi.fn(),
      openSync: vi.fn(),
      openBackup: vi.fn(),
      openSettings: vi.fn(),
      openExternalSource: vi.fn(),
      openExternalSourceSettings: vi.fn(),
    },
  },
} as unknown as LibraryScreenProps;

it.each(['available', 'imported'] as const)('passes work and episode titles for %s image episodes', (importState) => {
  const item = {
    ...controller().items[0]!,
    importState,
    title: 'Episode',
    release: { title: 'Episode' },
    collection: { remoteId: 'work', title: 'Collection' },
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SourceHubScreen
        controller={controller({
          items: [item],
          detail: { title: 'Work Detail' },
          streaming: { item, port: { open: vi.fn() } },
        })}
        library={library}
        openSourceSettings={vi.fn()}
      />,
    );
  });
  try {
    expect(renderer.root.findByType(SourceStreamReader).props).toMatchObject({
      title: 'Episode',
      workTitle: 'Work Detail',
    });
  } finally {
    act(() => renderer.unmount());
  }
});
