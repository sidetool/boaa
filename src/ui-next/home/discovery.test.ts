import { expect, it, vi } from 'vitest';
import { DiscoverySession } from '../../features/discovery/discovery-session';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { ExternalItemPage, TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import type { DiscoveryConfig } from '../../features/discovery/discovery-config';
import { HomeDiscoveryLoader, homeDiscoverySections, homeSourceSection } from './discovery';
import { createUiNextHomeAdapter, type HomeAdapterInput } from './model';
import { actions, model } from '../test-fixtures';
import { sourceRowInput } from './source-row';

const work = {
  key: { connectorId: 'fixture.source', remoteId: 'work' },
  title: '작품',
  kind: 'work' as const,
  importability: 'supported' as const,
  navigationRef: 'detail',
  coverRef: { connectorId: 'fixture.source', remoteId: 'cover' },
};
function fixture() {
  const list = vi.fn<(...args: unknown[]) => Promise<ExternalItemPage>>().mockResolvedValue({ items: [work] });
  const cover = vi.fn().mockResolvedValue('blob:cover');
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected' }),
    getExternalSources: () => [{ descriptor: { id: 'fixture.source', capabilities: ['browse'] } }],
    listExternalSource: list,
    resolveExternalSourceCover: cover,
  } as unknown as ExternalSourceRegistryPort;
  const session = new DiscoverySession(registry, {} as TrustedExternalSourceHostContext, 'home-test');
  const sources = {
    sources: [
      {
        id: 'fixture.source',
        title: '테스트 소스',
        kind: 'catalog',
        origin: 'plugin',
        connection: { state: 'connected' },
      },
    ],
    libraryWorks: [{ connectorId: 'fixture.source', collectionRemoteId: 'work' }],
  } as unknown as ExternalSourceController;
  const config: DiscoveryConfig = {
    version: 1,
    tabs: [
      {
        id: 'tab',
        title: '탭',
        hidden: false,
        density: 'comfortable',
        sections: [{ id: 'section', sourceId: 'fixture.source', mode: 'popular', title: '' }],
      },
    ],
  };
  const sections = homeDiscoverySections(config, sources.sources);
  const loader = new HomeDiscoveryLoader(session);
  const open = vi.fn();
  const openAll = vi.fn();
  const props = { model: model([]), actions: actions() };
  const input: HomeAdapterInput = {
    books: [],
    externalWorks: [],
    memberships: [],
    setConfig: vi.fn(),
    navigation: { openLibraryRoot: vi.fn() },
    config: [{ id: 'home-row', kind: 'discovery', visible: true, discoveryTabId: sections[0].id }],
    discoveryRows: { sections, row: (config) => loader.row(config, sections[0], sources, open, openAll) },
  };
  const adapter = () => createUiNextHomeAdapter(props, input);
  const row = () => adapter().rows[0];
  return { list, cover, session, registry, sources, config, sections, loader, input, adapter, row, open, openAll };
}
it('does not request on adapter construction, loads once on demand, caps items and lazily resolves covers', async () => {
  const f = fixture();
  f.list.mockResolvedValue({ items: Array.from({ length: 24 }, (_, index) => ({ ...work, title: `작품 ${index}` })) });
  expect(f.row()).toMatchObject({ status: 'loading', title: '테스트 소스 · 인기', eyebrow: '테스트 소스' });
  expect(f.list).not.toHaveBeenCalled();
  expect(f.cover).not.toHaveBeenCalled();
  f.row().requestLoad!();
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  f.row().requestLoad!();
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.row().items).toHaveLength(20);
  const item = f.row().items[0];
  if (item.kind !== 'discovery') throw new Error('Expected discovery');
  expect(item.work.owned).toBe(true);
  expect(f.cover).not.toHaveBeenCalled();
  await item.work.loadCover!(new AbortController().signal);
  expect(f.cover).toHaveBeenCalledOnce();
  item.work.open();
  expect(f.open).toHaveBeenCalledWith('fixture.source', { parentRef: 'detail' }, '작품 0');
  f.row().openAll!();
  expect(f.openAll).toHaveBeenCalledWith('tab');
  f.session.dispose();
});

function cachedRowFixture(kind: 'discovery' | 'source') {
  const f = fixture();
  const section = {
    ...f.sections[0].section,
    title: 'Saved row',
    filters: [{ position: 0, value: 1 }],
    filterSignature: '[]',
  };
  const config = { id: `cached-${kind}`, kind, visible: true, section };
  const list = kind === 'source' ? homeSourceSection(config, f.sources.sources)! : { ...f.sections[0], section };
  const input = sourceRowInput(section);
  const saved: ExternalItemPage = {
    items: [work],
    browse: { activeMode: 'search', availableModes: ['popular', 'search'], filters: [] },
    cache: { fetchedAt: Date.now(), stale: true },
  };
  const row = () => f.loader.row(config, list, f.sources, f.open, f.openAll);
  return { ...f, row, input, saved };
}

it.each(['discovery', 'source'] as const)(
  'returns validated memory items and covers on the first %s row read',
  async (kind) => {
    const f = cachedRowFixture(kind);
    f.list.mockResolvedValue(f.saved);
    await f.session.list('fixture.source', f.input);
    f.list.mockClear();
    vi.spyOn(f.session, 'peekCover').mockReturnValue('blob:already-seen');
    const restore = vi.spyOn(f.session, 'restore');
    const schema = vi.spyOn(f.session, 'schema').mockResolvedValue(f.saved);
    const changed = vi.fn();
    const unsubscribe = f.loader.subscribe(changed);
    expect(f.row()).toMatchObject({
      status: 'ready',
      items: [{ work: { title: work.title, thumbnailUrl: 'blob:already-seen' } }],
    });
    expect(f.list).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(schema).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    f.list.mockResolvedValue({ ...f.saved, cache: undefined, items: [{ ...work, title: 'Updated' }] });
    f.row().requestLoad!();
    await vi.waitFor(() => expect(f.row().items[0]).toMatchObject({ work: { title: 'Updated' } }));
    expect(f.list).toHaveBeenCalledOnce();
    unsubscribe();
    f.session.dispose();
  },
);

it.each(['discovery', 'source'] as const)(
  'publishes restored %s items before schema resolves, including on retry',
  async (kind) => {
    const f = cachedRowFixture(kind);
    vi.spyOn(f.session, 'restore').mockResolvedValue(f.saved);
    let reject!: (error: Error) => void;
    const schema = vi.spyOn(f.session, 'schema').mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    expect(f.row().status).toBe('loading');
    f.row().requestLoad!();
    await vi.waitFor(() =>
      expect(f.row()).toMatchObject({ status: 'ready', items: [{ work: { title: work.title } }] }),
    );
    expect(schema).toHaveBeenCalledOnce();
    expect(f.list).not.toHaveBeenCalled();
    reject(new Error('offline'));
    await vi.waitFor(() =>
      expect(f.row()).toMatchObject({ status: 'ready', error: 'offline', items: [{ work: { title: work.title } }] }),
    );
    let resolve!: (page: ExternalItemPage) => void;
    schema.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.mocked(f.session.restore).mockResolvedValue({ ...f.saved, items: [{ ...work, title: 'Restored on retry' }] });
    f.row().retry!();
    await vi.waitFor(() =>
      expect(f.row()).toMatchObject({ status: 'ready', items: [{ work: { title: 'Restored on retry' } }] }),
    );
    expect(f.list).not.toHaveBeenCalled();
    resolve(f.saved);
    f.list.mockResolvedValue({ ...f.saved, cache: undefined, items: [{ ...work, title: 'Updated' }] });
    await vi.waitFor(() => expect(f.row().items[0]).toMatchObject({ work: { title: 'Updated' } }));
    f.session.dispose();
  },
);

it.each(
  (['discovery', 'source'] as const).flatMap((kind) =>
    (['mode', 'signature'] as const).map((invalid) => ({ kind, invalid })),
  ),
)('does not publish $kind cached pages with incompatible $invalid', async ({ kind, invalid }) => {
  const f = cachedRowFixture(kind);
  const incompatible: ExternalItemPage =
    invalid === 'mode'
      ? { ...f.saved, browse: { activeMode: 'popular', availableModes: ['popular'], filters: [] } }
      : {
          ...f.saved,
          browse: {
            ...f.saved.browse!,
            filters: [{ id: 'changed', kind: 'text', label: 'Changed', position: 0, defaultValue: '' }],
          },
        };
  vi.spyOn(f.session, 'peek').mockReturnValue({ page: incompatible, time: Date.now(), bytes: 1 });
  vi.spyOn(f.session, 'restore').mockResolvedValue(incompatible);
  let resolve!: (page: ExternalItemPage) => void;
  const schema = vi.spyOn(f.session, 'schema').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const list = vi.spyOn(f.session, 'list').mockResolvedValue({ ...f.saved, cache: undefined });
  expect(f.row()).toMatchObject({ status: 'loading', items: [] });
  f.row().requestLoad!();
  await vi.waitFor(() => expect(schema).toHaveBeenCalledOnce());
  expect(f.row()).toMatchObject({ status: 'loading', items: [] });
  expect(list).not.toHaveBeenCalled();
  resolve(f.saved);
  await vi.waitFor(() => expect(f.row()).toMatchObject({ status: 'ready', items: [{ work: { title: work.title } }] }));
  f.session.dispose();
});
it('exposes each section as a synced editor option and ignores deleted section configs', () => {
  const f = fixture();
  f.input.config = [];
  const option = f.adapter().rowOptions.find((option) => option.kind === 'discovery')!;
  expect(option).toMatchObject({ label: '테스트 소스', discoveryTabId: JSON.stringify(['tab', 'section']) });
  f.adapter().setConfig([{ id: 'list', kind: 'discovery', visible: true, discoveryTabId: option.discoveryTabId }]);
  expect(f.input.setConfig).toHaveBeenCalledWith([expect.objectContaining({ discoveryTabId: option.discoveryTabId })]);
  f.input.config = [{ id: 'gone', kind: 'discovery', visible: true, discoveryTabId: 'deleted' }];
  expect(f.adapter().rows).toEqual([]);
  expect(f.adapter().config).toEqual([]);
  expect(f.list).not.toHaveBeenCalled();
  f.session.dispose();
});
it('publishes restored cache before the list resolves and preserves it on failure, with forced retry', async () => {
  const f = fixture();
  vi.spyOn(f.session, 'restore').mockResolvedValue({ items: [work] });
  let reject!: (error: Error) => void;
  const list = vi.spyOn(f.session, 'list').mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().items).toHaveLength(1));
  expect(f.row().status).toBe('ready');
  reject(new Error('offline'));
  await vi.waitFor(() => expect(f.row()).toMatchObject({ status: 'ready', error: 'offline' }));
  f.row().retry!();
  await vi.waitFor(() =>
    expect(list).toHaveBeenLastCalledWith('fixture.source', expect.objectContaining({ browseMode: 'popular' }), true),
  );
  expect(f.row()).toMatchObject({ status: 'ready', error: undefined });
  f.session.dispose();
});
it.each(['disconnected', 'unsupported', 'schema'] as const)('fails safely for %s', async (reason) => {
  const f = fixture();
  if (reason === 'disconnected')
    Object.assign(f.sources, { sources: [{ ...f.sources.sources[0], connection: { state: 'disconnected' } }] });
  if (reason === 'unsupported')
    f.list.mockResolvedValue({ items: [], browse: { activeMode: 'popular', availableModes: ['search'] } });
  if (reason === 'schema') {
    f.sections[0].section.filterSignature = '["changed"]';
    vi.spyOn(f.session, 'schema').mockResolvedValue({ items: [] });
  }
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('failed'));
  expect(f.row().error).toBeTruthy();
  if (reason !== 'unsupported') expect(f.list).not.toHaveBeenCalled();
  f.session.dispose();
});
it('shares the session per-source queue when multiple different home rows become near simultaneously', async () => {
  const f = fixture();
  const releases: Array<() => void> = [];
  f.list.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve({ items: [] }))));
  const second = {
    ...f.sections[0],
    id: 'second',
    section: { ...f.sections[0].section, id: 'second', mode: 'latest' as const },
  };
  const secondConfig = { id: 'second', kind: 'discovery' as const, visible: true, discoveryTabId: 'second' };
  f.row().requestLoad!();
  const other = () => f.loader.row(secondConfig, second, f.sources, f.open, f.openAll);
  other().requestLoad!();
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
  releases.shift()!();
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
  releases.shift()!();
  await vi.waitFor(() => expect(other().status).toBe('ready'));
  f.session.dispose();
});
it('reuses a fresh page already loaded by discovery without another network request', async () => {
  const f = fixture();
  await f.session.list('fixture.source', { browseMode: 'popular' });
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  expect(f.list).toHaveBeenCalledOnce();
  f.session.dispose();
});
it('checks saved filter schema before fetching the filtered list', async () => {
  const f = fixture();
  const filters: [] = [];
  f.sections[0].section.filters = filters;
  f.sections[0].section.parentRef = 'category';
  f.sections[0].section.filterSignature = '[]';
  const browse = { activeMode: 'popular' as const, availableModes: ['popular' as const], filters };
  const schema = vi.spyOn(f.session, 'schema').mockResolvedValue({ items: [], browse });
  f.list.mockResolvedValue({ items: [work], browse });
  f.row().requestLoad!();
  await vi.waitFor(() => expect(f.row().status).toBe('ready'));
  expect(schema).toHaveBeenCalledWith('fixture.source', { parentRef: 'category', browseMode: 'popular' }, false);
  expect(f.list.mock.calls[0][2]).toMatchObject({ parentRef: 'category', browseMode: 'popular', filters });
  f.session.dispose();
});

it('loads independent filters from the same source using search and keeps disabled rows in saved edits', async () => {
  const f = fixture();
  const rows = [1, 2].map((value) => ({
    id: `source-${value}`,
    kind: 'source' as const,
    visible: true,
    section: {
      sourceId: 'fixture.source',
      mode: 'popular' as const,
      title: `Row ${value}`,
      filters: [{ position: 0, value }],
    },
  }));
  f.input.config = rows;
  f.input.discoveryRows = {
    sections: [],
    rowBuilder: {
      session: f.session,
      sources: f.sources.sources,
      sourceView: (id) => f.sources.sources.find((source) => source.id === id),
    },
    row: (config) => f.loader.row(config, homeSourceSection(config, f.sources.sources)!, f.sources, f.open, f.openAll),
  };
  const first = f.adapter();
  expect(first.rows.map((row) => [row.title, row.eyebrow, row.ranked])).toEqual([
    ['Row 1', '테스트 소스', false],
    ['Row 2', '테스트 소스', false],
  ]);
  expect(first.rowLabel(rows[0])).toBe('Row 1');
  expect(first.rowBuilder?.session).toBe(f.session);
  first.rows.forEach((row) => row.requestLoad!());
  await vi.waitFor(() => expect(f.adapter().rows.every((row) => row.status === 'ready')).toBe(true));
  expect(f.list).toHaveBeenCalledTimes(2);
  expect(f.list.mock.calls.map((call) => call[2])).toEqual([
    expect.objectContaining({ browseMode: 'search', filters: rows[0].section.filters }),
    expect.objectContaining({ browseMode: 'search', filters: rows[1].section.filters }),
  ]);
  for (const call of f.list.mock.calls) expect(call[2]).not.toHaveProperty('query');
  first.rows[0].openAll!();
  expect(f.open).toHaveBeenCalledWith(
    'fixture.source',
    expect.objectContaining({ browseMode: 'search', filters: rows[0].section.filters }),
    'Row 1',
  );
  f.input.discoveryRows.rowBuilder!.sources = [];
  expect(f.adapter().rows).toEqual([]);
  f.adapter().setConfig([{ id: 'unread', kind: 'unread', visible: true }]);
  expect(f.input.setConfig).toHaveBeenCalledWith([...rows, { id: 'unread', kind: 'unread', visible: true }]);
  f.input.discoveryRows.rowBuilder!.sources = f.sources.sources;
  expect(f.adapter().rows).toHaveLength(2);
  f.session.dispose();
});
