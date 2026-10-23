import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeHomeRows } from '@boaa/reader-core/settings';
import { HomePluginLoader, type HomePluginFeed, type HomePluginSection } from './plugin-home';
import { appendPluginHomeRows, mergeHomeRowEdits, resolveHomeRows } from './config';
import { createUiNextHomeAdapter } from './model';
import { actions, model } from '../test-fixtures';
import { DiscoveryCard, HomeRow, rowUpdatedLabel } from './rows';
import { getSearchRoute, setSearchRoute } from '../search/route';
import { closePluginView, getPluginViewRoute } from '../plugins/view-route';
import { UiNextSearchScreen } from '../search/UiNextSearchScreen';
import type { UiNextSearchAdapter } from '../search/contract';
import type { HomeRowConfig } from './contract';

const section: HomePluginSection = {
  pluginId: 'fixture.ranking',
  installationId: 'install',
  digest: 'digest',
  revision: 1,
  pluginName: '추천 목록',
  section: { id: 'today', title: '오늘의 인기 작품' },
};
const page: HomePluginFeed = {
  items: [
    { id: 'one', title: '작품 제목', rank: 3, searchQuery: '검색할 제목', coverUrl: 'https://example.invalid/image' },
  ],
  ttlSeconds: 60,
};
function fixture() {
  const service = {
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => 0,
    homeSections: vi.fn().mockResolvedValue([section]),
    homeFeed: vi.fn().mockResolvedValue(page),
    homeCover: vi.fn().mockResolvedValue('blob:host-cover'),
  };
  const loader = new HomePluginLoader(service);
  const config = appendPluginHomeRows([], [section])[0];
  return { service, loader, config, row: () => loader.row(config) };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  setSearchRoute(undefined);
  closePluginView();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('adds enabled plugin sections to home and opens a title search that automatically submits', async () => {
  const f = fixture();
  await f.loader.sync();
  const props = { model: model([]), actions: actions() };
  const adapter = () =>
    createUiNextHomeAdapter(props, {
      books: [],
      externalWorks: [],
      memberships: [],
      config: [],
      setConfig: vi.fn(),
      navigation: { openLibraryRoot: vi.fn() },
      pluginRows: { sections: f.loader.sections, row: (config) => f.loader.row(config) },
    });
  expect(adapter().rows).toHaveLength(1);
  expect(f.service.homeFeed).not.toHaveBeenCalled();
  adapter().rows[0].requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  const item = adapter().rows[0].items[0];
  if (item.kind !== 'discovery') throw Error('Wrong card');
  expect(item.work.thumbnailUrl).toBeUndefined();
  await expect(item.work.loadCover!(new AbortController().signal)).resolves.toBe('blob:host-cover');
  expect(f.service.homeCover).toHaveBeenCalledWith(
    section.pluginId,
    section.section.id,
    page.items[0].coverUrl,
    expect.any(AbortSignal),
  );
  act(() => {
    renderer = create(<DiscoveryCard work={item.work} ranked rank={item.work.rank} />);
  });
  act(() => renderer!.root.findByProps({ 'aria-label': '작품 제목 검색' }).props.onClick());
  expect(getSearchRoute()?.initialQuery).toBe('검색할 제목');
  expect(renderer!.root.findByProps({ className: 'un-poster-rank' }).children).toEqual(['3']);
  const search: UiNextSearchAdapter = {
    library: () => [],
    libraryHelpers: adapter().library,
    submitted: '',
    sources: [],
    recent: [],
    submit: vi.fn(),
    cancel: vi.fn(),
    clearRecent: vi.fn(),
    removeRecent: vi.fn(),
  };
  act(() =>
    renderer!.update(
      <UiNextSearchScreen adapter={search} initialQuery={getSearchRoute()?.initialQuery} close={vi.fn()} />,
    ),
  );
  expect(search.submit).toHaveBeenCalledWith('검색할 제목');
  f.loader.dispose();
});
it('disabling during a pending load revokes late results, covers and click actions', async () => {
  const f = fixture();
  await f.loader.sync();
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  const old = f.row().items[0];
  let resolve!: (value: HomePluginFeed) => void;
  f.service.homeFeed.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.row().retry!();
  const signal = f.service.homeFeed.mock.lastCall![2] as AbortSignal;
  f.service.homeSections.mockResolvedValue([]);
  await f.loader.sync();
  expect(signal.aborted).toBe(true);
  resolve({ items: [{ id: 'late', title: '늦은 작품' }] });
  await Promise.resolve();
  expect(f.loader.sections).toEqual([]);
  expect(f.row().items).toEqual([]);
  if (old.kind !== 'discovery') throw Error('Wrong card');
  old.work.open();
  expect(getSearchRoute()).toBeUndefined();
  await expect(old.work.loadCover!(new AbortController().signal)).resolves.toBeUndefined();
  f.loader.dispose();
});
it('keeps ordering and hidden rows through disable, unavailable devices, removal and reinstall', () => {
  const plugin = appendPluginHomeRows([], [section])[0];
  const library: HomeRowConfig = { id: 'library', kind: 'unread', visible: true };
  const saved = [{ ...plugin, visible: false }, library];
  expect(resolveHomeRows(saved, [], [], [], [])).toEqual([library]);
  const edited = mergeHomeRowEdits(saved, [library], [{ ...library, visible: false }]);
  expect(resolveHomeRows(edited, [], [], [], [{ ...section, installationId: 'replacement' }])).toEqual([
    { ...plugin, visible: false },
    { ...library, visible: false },
  ]);
  expect(mergeHomeRowEdits([plugin], [plugin], [])).toEqual([{ ...plugin, visible: false }]);
  expect(appendPluginHomeRows(saved, [section])).toEqual(saved);
  expect(normalizeHomeRows(saved)).toEqual(saved);
});
it('retains cached results on server failure, exposes retry and backs off repeated requests', async () => {
  const f = fixture();
  await f.loader.sync();
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  f.service.homeFeed.mockRejectedValueOnce(Error('offline'));
  f.row().retry!();
  await vi.waitFor(() => expect(f.row().error).toBeTruthy());
  expect(f.row()).toMatchObject({ status: 'ready', stale: true, items: [{ work: { title: '작품 제목' } }] });
  f.row().requestLoad!();
  expect(f.service.homeFeed).toHaveBeenCalledTimes(2);
  act(() => {
    renderer = create(<HomeRow row={f.row()}>목록</HomeRow>);
  });
  expect(renderer!.root.findByProps({ role: 'status' }).children.join('')).toContain('목록을 새로 불러오지 못했어요');
  act(() =>
    renderer!.root
      .findAllByType('button')
      .find((button) => button.children.includes('다시 시도'))!
      .props.onClick(),
  );
  await vi.waitFor(() => expect(f.row().error).toBeUndefined());
  await vi.waitFor(() => expect(f.row().refreshing).toBe(false));
  expect(f.service.homeFeed).toHaveBeenCalledTimes(3);
  f.loader.dispose();
});
it('revalidates expired feeds and clears old cache after a package replacement', async () => {
  const f = fixture();
  await f.loader.sync();
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  const expires = f.row().refreshAt!;
  vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.service.homeFeed).toHaveBeenCalledTimes(2));
  f.service.homeSections.mockResolvedValue([{ ...section, digest: 'replacement', revision: 2 }]);
  await f.loader.sync();
  expect(f.row()).toMatchObject({ status: 'loading', items: [] });
  vi.restoreAllMocks();
  f.loader.dispose();
});
it('rejects malformed plugin row identity and caps automatic rows at the settings limit', () => {
  const config = appendPluginHomeRows([], [section])[0];
  expect(
    normalizeHomeRows([
      { ...config, pluginId: '../bad' },
      { ...config, pluginSectionId: '' },
    ]),
  ).toEqual([]);
  const full = Array.from({ length: 100 }, (_, index) => ({
    id: `row${index}`,
    kind: 'unread' as const,
    visible: true,
  }));
  expect(appendPluginHomeRows(full, [section])).toEqual(full);
});
it('labels row freshness compactly relative to today', () => {
  const now = new Date(2026, 9, 23, 18, 0).getTime();
  expect(rowUpdatedLabel(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('오늘 09:05');
  expect(rowUpdatedLabel(new Date(2026, 9, 22, 21, 30).getTime(), now)).toBe('어제 21:30');
  expect(rowUpdatedLabel(new Date(2026, 9, 3, 14, 0).getTime(), now)).toBe('10월 3일 14:00');
  expect(rowUpdatedLabel(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025년 12월 31일 08:00');
});

it('opens the declared plugin view of a section from its row action only while that section is current', async () => {
  const f = fixture();
  await f.loader.sync();
  expect(f.row().openAll).toBeUndefined();

  f.service.homeSections.mockResolvedValue([{ ...section, section: { ...section.section, view: 'browse' } }]);
  await f.loader.sync();
  const openAll = f.row().openAll!;
  openAll();
  expect(getPluginViewRoute()).toMatchObject({ pluginId: section.pluginId, view: 'browse', title: section.pluginName });
  expect(getSearchRoute()).toBeUndefined();

  closePluginView();
  f.loader.dispose();
  openAll();
  expect(getPluginViewRoute()).toBeUndefined();
});
