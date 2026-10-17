import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscoverySession } from './discovery-session';
import { useDiscoverySourceView } from './useDiscoverySourceView';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { ExternalSourceView } from '../external-sources/external-source-controller-contract';
import type { ExternalSourceListInput, TrustedExternalSourceHostContext } from '../../external-sources/contracts';
afterEach(() => vi.unstubAllGlobals());

it('isolates builder controls and page depth while sharing cached source pages and search-filter semantics', async () => {
  vi.stubGlobal('window', {});
  const source = {
    id: 'fixture.source',
    kind: 'catalog',
    title: 'Source',
    origin: 'plugin',
    connection: { state: 'connected' },
  } as ExternalSourceView;
  const section = { id: 'same-draft', sourceId: source.id, title: '', mode: 'popular' as const };
  const filters = [
    { id: 'genre', kind: 'select' as const, label: 'Genre', position: 0, options: ['All', 'Genre'], defaultValue: 0 },
  ];
  const list = vi.fn(async (_id: string, _context: unknown, input: ExternalSourceListInput) => ({
    items: [
      {
        key: { connectorId: source.id, remoteId: input.cursor ?? 'one' },
        title: 'Work',
        kind: 'work' as const,
        importability: 'supported' as const,
      },
    ],
    nextCursor: input.cursor ? undefined : 'two',
    browse: {
      activeMode: input.browseMode ?? 'popular',
      availableModes: ['popular', 'latest', 'search'] as const,
      filters,
    },
  }));
  const registry = {
    getExternalSourceStatus: () => source.connection,
    getExternalSources: () => [],
    listExternalSource: list,
  } as unknown as ExternalSourceRegistryPort;
  const session = new DiscoverySession(registry, {} as TrustedExternalSourceHostContext, 'source-builder');
  let a!: ReturnType<typeof useDiscoverySourceView>, b!: ReturnType<typeof useDiscoverySourceView>;
  function Probe({ slot }: { slot: 'a' | 'b' }) {
    const value = useDiscoverySourceView({
      section,
      source,
      session,
      refresh: 0,
      controls: true,
      purpose: 'row-builder',
    });
    if (slot === 'a') a = value;
    else b = value;
    return null;
  }
  let first!: ReactTestRenderer, second!: ReactTestRenderer;
  await act(async () => {
    first = create(createElement(Probe, { slot: 'a' }));
    second = create(createElement(Probe, { slot: 'b' }));
  });
  try {
    expect(list).toHaveBeenCalledTimes(1);
    expect(a.definitions).toEqual(filters);
    expect(a.data.items).toHaveLength(1);
    await act(async () => a.data.loadMore());
    expect(a.data.items).toHaveLength(2);
    expect(b.data.items).toHaveLength(1);
    act(() => {
      a.setFilterValue('genre', 1);
      a.setDraftQuery('must not be saved');
    });
    await act(async () => a.apply());
    expect(a.input).toMatchObject({ browseMode: 'search', filters: [{ position: 0, value: 1 }] });
    expect(a.input.query).toBeUndefined();
    expect(b.input.browseMode).toBe('popular');
    expect(b.getFilterValue(filters[0])).toBeUndefined();
    await act(async () => first.unmount());
    await act(async () => {
      first = create(createElement(Probe, { slot: 'a' }));
    });
    expect(a.input.browseMode).toBe('popular');
    expect(a.data.items).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => {
      first.unmount();
      second.unmount();
    });
    session.dispose();
  }
});
