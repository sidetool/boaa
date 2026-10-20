import type { HomeRowItem } from './contract';
import { describe, expect, it, vi } from 'vitest';
import { actions, model, novel } from '../test-fixtures';
import { buildLibraryBookView } from '../../features/library/library-screen-model';
import type { LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import { createUiNextHomeAdapter, type HomeAdapterInput } from './model';
import { defaultHomeRows, resolveHomeRows } from './config';

function book(id: string, patch: Parameters<typeof novel>[0] = {}) {
  return buildLibraryBookView(novel({ id, title: id, ...patch }), {
    hasReadActivity: (value) => Boolean(value.lastReadAt),
    isFinished: (value) => value.lastReadProgress >= 0.995,
  });
}
const remote: LibraryExternalWorkView = {
  id: 'remote',
  title: '원격 작품',
  availableReleaseCount: 10,
  readReleaseCount: 2,
  lastReadAt: '2026-10-14',
  newReleaseCount: 1,
  addedAt: '2026-10-01',
  updatedAt: '2026-10-14',
};
function fixture() {
  const props = { model: model([]), actions: actions() };
  props.actions.books.continueExternal = vi.fn();
  const input: HomeAdapterInput = {
    books: [
      book('reading', { lastReadAt: '2026-10-13', lastReadProgress: 0.3, lastReadChapterIndex: 3, totalChapters: 12 }),
      book('unread'),
      book('finished', { lastReadAt: '2026-10-12', lastReadProgress: 1 }),
      book('favorite', { favorite: true }),
    ],
    externalWorks: [remote],
    now: Date.parse('2026-10-15T01:00:00Z'),
    memberships: [],
    setConfig: vi.fn(),
    navigation: { openLibraryRoot: vi.fn(), openDiscovery: vi.fn() },
  };
  return { props, input, adapter: () => createUiNextHomeAdapter(props, input) };
}
const ids = (row: ReturnType<typeof createUiNextHomeAdapter>['rows'][number]) => row.items.map((item) => item.key);
describe('home catalog adapter', () => {
  it('sorts heroes by read activity, excludes never-read and deleted works, caps at five', () => {
    const { input, adapter } = fixture();
    input.books = [
      ...input.books,
      ...Array.from({ length: 7 }, (_, n) => book(`older-${n}`, { lastReadAt: '2026-01-01' })),
      book('trashed', { lastReadAt: '2026-10-15', deletedAt: '2026-10-15' }),
    ];
    input.externalWorks = [
      remote,
      { ...remote, id: 'never', lastReadAt: undefined, readReleaseCount: 0 },
      { ...remote, id: 'deleted', deletedAt: '2026-10-15' },
    ];
    const hero = adapter().hero;
    expect(hero).toHaveLength(5);
    expect(hero.slice(0, 3).map((item) => item.item.key)).toEqual(['external:remote', 'book:reading', 'book:older-0']);
    expect(
      hero.some((item) =>
        ['book:finished', 'book:unread', 'external:never', 'book:trashed', 'external:deleted'].includes(item.item.key),
      ),
    ).toBe(false);
  });
  it('reuses book labels, synopsis, actions and source activity for linked local books', () => {
    const { props, input, adapter } = fixture();
    const first = input.books[0];
    first.novel.description = '작품 소개';
    first.novel.tags = ['모험'];
    props.model.externalSources.bookReadingActivity = new Map([[first.novel.id, { lastReadAt: '2026-10-15' }]]);
    const hero = adapter().hero[0];
    expect(hero.item.key).toBe('book:reading');
    expect(hero.positionLabel).toBe('3화 / 12화');
    expect(hero.lastReadLabel).toBe('1시간 전');
    expect(hero.reason).toBe('continue');
    expect(hero.resumeLabel).toBe('3화 이어 읽기');
    expect(hero.synopsis).toBe('작품 소개');
    expect(hero.tags).toContain('모험');
    hero.resume();
    hero.openDetail();
    expect(props.actions.books.continueReading).toHaveBeenCalledWith(first.novel);
    expect(props.actions.books.open).toHaveBeenCalledWith(first.novel);
    input.externalWorks = [{ ...remote, description: '외부 작품 소개' }];
    const external = adapter().hero.find((item) => item.item.kind === 'external')!;
    expect(external.synopsis).toBe('외부 작품 소개');
    external.resume();
    external.openDetail();
    expect(props.actions.books.continueExternal).toHaveBeenCalledWith(remote.id);
    expect(props.actions.books.openExternal).toHaveBeenCalledWith(remote.id);
  });
  it('fills a never-read library with at most three recent unread works', () => {
    const { input, adapter } = fixture();
    input.books = Array.from({ length: 5 }, (_, index) =>
      book(`new-${index}`, { createdAt: new Date(2026, 0, index + 1).toISOString() }),
    );
    input.externalWorks = [{ ...remote, lastReadAt: undefined, readReleaseCount: 0 }];
    const hero = adapter().hero;
    expect(hero.map((item) => item.item.key)).toEqual(['external:remote', 'book:new-4', 'book:new-3']);
    expect(hero.every((item) => item.reason === 'new' && item.lastReadLabel === '')).toBe(true);
    expect(hero.every((item) => item.resumeLabel === '첫 화 보기')).toBe(true);
  });
  it('excludes completed remote/local works without treating a completed library as never read', () => {
    const { input, adapter } = fixture();
    input.books = [book('finished', { lastReadAt: '2026-10-14', lastReadProgress: 1 }), book('unread')];
    input.externalWorks = [{ ...remote, readReleaseCount: 10 }];
    expect(adapter().hero).toEqual([]);
  });
  it('uses identical relative labels for remote and local activity and only prefixes a known remote chapter', () => {
    const { props, input, adapter } = fixture();
    input.now = Date.parse('2026-10-14T00:05:00Z');
    props.model.externalSources.bookReadingActivity = new Map([['reading', { lastReadAt: remote.lastReadAt }]]);
    input.currentChapters = new Map([['external:remote', { index: 7, title: '장면 7' }]]);
    const hero = adapter().hero;
    expect(hero.every((item) => item.lastReadLabel === '5분 전')).toBe(true);
    const external = hero.find((item) => item.item.kind === 'external')!;
    expect(external.positionLabel).toBe('7화 · 장면 7');
    expect(external.resumeLabel).toBe('7화 이어 보기');
    input.currentChapters = undefined;
    expect(adapter().hero.find((item) => item.item.kind === 'external')!.resumeLabel).toBe('이어 보기');
  });
  it('derives rows from the full catalog, independent of query, filter, selection and shelf', () => {
    const { props, input, adapter } = fixture();
    input.config = ['recently-added', 'unread', 'finished', 'favorites', 'external-updates'].map((kind) => ({
      id: kind,
      kind: kind as NonNullable<HomeAdapterInput['config']>[number]['kind'],
      visible: true,
    }));
    const expected = adapter().rows.map(ids);
    props.model.query = 'no matches';
    props.model.filter = 'trash';
    props.model.management.activeShelfId = 'other';
    props.model.management.selectionMode = true;
    expect(adapter().rows.map(ids)).toEqual(expected);
    expect(ids(adapter().rows[1])).toEqual(['book:favorite', 'book:unread']);
    expect(ids(adapter().rows[2])).toEqual(['book:finished']);
    expect(ids(adapter().rows[3])).toEqual(['book:favorite']);
    expect(ids(adapter().rows[4])).toEqual(['external:remote']);
    adapter().library.activate({ kind: 'book', key: 'book:unread', book: input.books[1] });
    expect(props.actions.books.open).toHaveBeenCalledWith(input.books[1].novel);
    expect(props.actions.books.toggleSelected).not.toHaveBeenCalled();
  });
  it('sorts additions, limits rows to twenty and includes local/remote shelf memberships', () => {
    const { props, input, adapter } = fixture();
    props.model.management.shelves = [
      { id: 's1', name: '책장', createdAt: '', updatedAt: '', sortOrder: 0, revision: 0 },
    ];
    input.books = Array.from({ length: 24 }, (_, n) =>
      book(`book-${n}`, { createdAt: new Date(2026, 0, n + 1).toISOString() }),
    );
    input.memberships = [
      { bookId: 'book-0', shelfId: 's1' },
      { bookId: 'external:remote', shelfId: 's1' },
    ];
    input.config = [...defaultHomeRows(), { id: 'shelf', kind: 'shelf', shelfId: 's1', visible: true }];
    expect(adapter().rows[0].items).toHaveLength(20);
    expect(ids(adapter().rows[0]).slice(0, 2)).toEqual(['external:remote', 'book:book-23']);
    expect(ids(adapter().rows.at(-1)!)).toEqual(['external:remote', 'book:book-0']);
    adapter().rows.at(-1)!.openAll!();
    expect(input.navigation.openLibraryRoot).toHaveBeenCalled();
    expect(props.actions.controls.setShelf).toHaveBeenCalledWith('s1');
    expect(props.actions.controls.setFilter).toHaveBeenCalledWith('all');
  });
  it('keeps defaults, hidden rows and shelf choices, ignores deleted shelves, excludes discovery options', () => {
    const { props, input, adapter } = fixture();
    expect(adapter().config.map((row) => row.kind)).toEqual([
      'recently-added',
      'unread',
      'external-updates',
      'favorites',
    ]);
    expect(adapter().rowOptions.some((row) => row.kind === 'discovery')).toBe(false);
    props.model.management.shelves = [
      { id: 's1', name: '책장', createdAt: '', updatedAt: '', sortOrder: 0, revision: 0 },
    ];
    expect(adapter().rowOptions.some((row) => row.shelfId === 's1')).toBe(true);
    input.config = [
      { id: 'hidden', kind: 'shelf', shelfId: 's1', visible: false },
      { id: 'deleted', kind: 'shelf', shelfId: 'missing', visible: true },
    ];
    expect(adapter().config.map((row) => row.id)).toEqual(['hidden']);
    expect(adapter().rows).toEqual([]);
    expect(adapter().rowOptions.some((row) => row.shelfId === 's1')).toBe(false);
    adapter().resetConfig();
    expect(input.setConfig).toHaveBeenCalledWith(defaultHomeRows());
    expect(resolveHomeRows([], [])).toEqual([]);
    adapter().setConfig([]);
    expect(input.setConfig).toHaveBeenLastCalledWith([input.config[1]]);
  });
  it('opens matching library filters and exposes existing import/discovery commands', () => {
    const { props, input, adapter } = fixture();
    adapter().rows.find((row) => row.config.kind === 'recently-added')!.openAll!();
    expect(props.actions.controls.setSort).not.toHaveBeenCalled();
    adapter().rows.find((row) => row.config.kind === 'unread')!.openAll!();
    expect(props.actions.controls.setFilter).toHaveBeenCalledWith('unread');
    adapter().rows.find((row) => row.config.kind === 'favorites')!.openAll!();
    expect(props.actions.controls.setFilter).toHaveBeenCalledWith('favorite');
    expect(props.actions.header.setQuery).toHaveBeenCalledWith('');
    expect(props.actions.controls.setSort).not.toHaveBeenCalled();
    adapter().importFiles();
    adapter().addSamples?.();
    adapter().openDiscovery?.();
    expect(props.actions.header.openImport).toHaveBeenCalled();
    expect(props.actions.books.addSample).toHaveBeenCalled();
    expect(input.navigation.openDiscovery).toHaveBeenCalled();
  });
  it('includes linked downloaded books with new releases and preserves source loading state', () => {
    const { props, input, adapter } = fixture();
    input.updatedBookIds = new Set(['reading']);
    props.model.externalSources.libraryBootstrap = { status: 'failed' };
    const row = adapter().rows.find((row) => row.config.kind === 'external-updates')!;
    expect(ids(row)).toEqual(['external:remote', 'book:reading']);
    expect(row.status).toBe('failed');
    expect(row.openAll).toBeUndefined();
  });
});

it('preserves unavailable shelf/discovery rows when editing an available row', () => {
  const { input, props, adapter } = fixture();
  props.model.management.shelves = [];
  input.config = [
    { id: 'unread', kind: 'unread', visible: true },
    { id: 'shelf', kind: 'shelf', shelfId: 's1', visible: true },
    { id: 'discovery', kind: 'discovery', discoveryTabId: 'tab', visible: true },
  ];
  const before = adapter();
  expect(before.config.map((row) => row.id)).toEqual(['unread']);
  before.setConfig([{ ...before.config[0], visible: false }]);
  expect(input.setConfig).toHaveBeenLastCalledWith([
    { ...input.config[0], visible: false },
    input.config[1],
    input.config[2],
  ]);
  before.setConfig([]);
  expect(input.setConfig).toHaveBeenLastCalledWith([input.config[1], input.config[2]]);
});

it('hides home source ranks by default and toggles only eligible rows without changing their content', () => {
  const { input, adapter } = fixture();
  input.config = [{ id: 'popular', kind: 'discovery', visible: true, discoveryTabId: 'list' }];
  const items: HomeRowItem[] = [];
  let eligible = true;
  input.discoveryRows = {
    sections: [
      {
        id: 'list',
        tabId: 'tab',
        tabTitle: '탐색',
        title: '인기',
        sourceLabel: '소스',
        section: { id: 'section', sourceId: 'source', mode: 'popular', title: '인기' },
      },
    ],
    row: (config) => ({ config, title: '인기', status: 'ready', ranked: eligible, items }),
  };
  expect(adapter().rows[0].ranked).toBe(false);
  input.showSourceRanks = true;
  expect(adapter().rows[0].ranked).toBe(true);
  expect(adapter().rows[0].items).toBe(items);
  eligible = false;
  expect(adapter().rows[0].ranked).toBe(false);
  input.showSourceRanks = false;
  eligible = true;
  expect(adapter().rows[0].ranked).toBe(false);
});
