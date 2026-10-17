import { vi } from 'vitest';
import type { Novel } from '../domain/types';
import type { LibraryScreenActions, LibraryScreenModel } from '../features/library/library-screen-contract';
import { buildLibraryCollectionModel, type NovelReadStateSelectors } from '../features/library/library-screen-model';
const readState: NovelReadStateSelectors = {
  hasReadActivity: (novel) =>
    Boolean(novel.lastReadAt || novel.lastReadProgress > 0 || (novel.readingSeconds ?? 0) > 0),
  isFinished: (novel) => novel.lastReadProgress >= 0.995,
};

export function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'novel-1',
    title: '테스트 소설',
    sourceFileName: 'test.txt',
    sourceEncoding: 'utf-8',
    rawText: '본문',
    normalizedText: '본문',
    rawTextHash: 'raw-hash',
    normalizedTextHash: 'normalized-hash',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    totalChapters: 2,
    totalCharacters: 1200,
    totalParagraphs: 20,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

export function actions(): LibraryScreenActions {
  return {
    drag: {
      enter: vi.fn(),
      over: vi.fn(),
      leave: vi.fn(),
      drop: vi.fn(),
      dropOnEmptyState: vi.fn(),
    },
    header: {
      setQuery: vi.fn(),
      retryBootstrap: vi.fn(),
      openSync: vi.fn(),
      openSettings: vi.fn(),
      openBackup: vi.fn(),
      openImport: vi.fn(),
      openLibraryFolders: vi.fn(),
      openExternalSource: vi.fn(),
      openExternalSourceBrowse: vi.fn(),
      openExternalSourceSettings: vi.fn(),
    },
    presentation: {
      goHome: vi.fn(),
      focusBook: vi.fn(),
      previewBook: vi.fn(),
      keepInspectorOpen: vi.fn(),
      closeInspectorSoon: vi.fn(),
      closeInspector: vi.fn(),
    },
    controls: {
      setFilter: vi.fn(),
      setSort: vi.fn(),
      setViewMode: vi.fn(),
      emptyTrash: vi.fn(),
      setShelf: vi.fn(),
      openShelves: vi.fn(),
      startSelection: vi.fn(),
      selectVisible: vi.fn(),
      clearSelection: vi.fn(),
      applyBatch: vi.fn(),
      exportSelectedMetadata: vi.fn(),
    },
    books: {
      open: vi.fn(),
      continueReading: vi.fn(),
      toggleFavorite: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      purge: vi.fn(),
      downloadSource: vi.fn(),
      addSample: vi.fn(),
      editMetadata: vi.fn(),
      toggleSelected: vi.fn(),
      openExternal: vi.fn(),
      removeExternal: vi.fn(),
    },
    imports: {
      open: vi.fn(),
      dismiss: vi.fn(),
    },
  };
}

export function model(novels: Novel[], overrides: Partial<LibraryScreenModel> = {}): LibraryScreenModel {
  return {
    bootstrap: { status: 'ready' },
    drop: { active: false, importBusy: false },
    query: '',
    sync: { label: '연결 안 됨', tone: 'local' },
    externalSources: { active: false, busy: false, sources: [] },
    importTasks: [],
    filter: 'all',
    sort: 'recent',
    viewMode: 'grid',
    collection: buildLibraryCollectionModel({
      novels,
      query: '',
      filter: 'all',
      sort: 'recent',
      readState,
    }),
    presentation: {
      layoutMode: 'wide',
      focusedBookId: novels[0]?.id,
      inspectorOpen: true,
      shelfBookCounts: new Map(),
    },
    management: {
      available: true,
      shelves: [],
      selectionMode: false,
      selectedBookIds: new Set(),
      busy: false,
    },
    ...overrides,
  };
}
