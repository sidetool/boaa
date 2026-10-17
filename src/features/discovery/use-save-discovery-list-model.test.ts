import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { DiscoveryController } from './useDiscoveryController';
import { newTab } from './discovery-config';
import { useSaveDiscoveryListModel, type SaveDiscoveryListModel } from './use-save-discovery-list-model';
it('saves list filters and parent without a search query and exposes the section limit', async () => {
  const save = vi.fn().mockResolvedValue(undefined),
    close = vi.fn();
  const tab = newTab('Tab');
  const discovery = { config: { version: 1, tabs: [tab] }, save } as unknown as DiscoveryController;
  const source = {
    activeSourceId: 'source',
    browse: { activeMode: 'latest', filters: [{ id: 'genre', position: 0, defaultValue: 'all' }] },
    filterValues: { genre: 'chosen' },
    breadcrumbs: [{ parentRef: 'parent' }],
  } as unknown as ExternalSourceController;
  let model!: SaveDiscoveryListModel;
  function Harness() {
    model = useSaveDiscoveryListModel({ discovery, source, close });
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Harness));
  });
  act(() => model.setTitle(' Saved '));
  await act(async () => {
    await model.submit();
  });
  const section = save.mock.calls[0][0].tabs[0].sections[0];
  expect(section).toMatchObject({
    sourceId: 'source',
    title: 'Saved',
    mode: 'latest',
    parentRef: 'parent',
    filters: [{ position: 0, value: 'chosen' }],
  });
  expect(section.query).toBeUndefined();
  expect(tab.sections).toEqual([]);
  expect(close).toHaveBeenCalledOnce();
  tab.sections = Array.from({ length: 60 }, () => section);
  await act(async () => {
    await model.submit();
  });
  expect(model.error).toEqual({ code: 'section_limit', limit: 60 });
  expect(save).toHaveBeenCalledOnce();
  act(() => app.unmount());
});
