import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { newTab, type DiscoveryConfig } from './discovery-config';
import { useDiscoveryEditorModel, type DiscoveryEditorModel } from './use-discovery-editor-model';
it('edits an isolated draft, clears source-specific filters, restores deletions and validates before saving', async () => {
  const config: DiscoveryConfig = {
    version: 1,
    tabs: [
      {
        ...newTab('First'),
        sections: [
          {
            id: 'row',
            sourceId: 'old',
            title: '',
            mode: 'popular',
            filters: [{ position: 0, value: 'x' }],
            filterSignature: 'schema',
            parentRef: 'parent',
          },
        ],
      },
    ],
  };
  const sources: ExternalSourceView[] = [
    { id: 'sample.new', title: 'Source', origin: 'plugin', kind: 'catalog', connection: { state: 'connected' } },
  ];
  const save = vi.fn().mockResolvedValue(undefined),
    close = vi.fn();
  let model!: DiscoveryEditorModel;
  function Harness() {
    model = useDiscoveryEditorModel({ config, sources, save, close });
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Harness));
  });
  act(() => model.setSectionSource(0, 0, 'sample.new'));
  expect(model.draft.tabs[0].sections[0]).toEqual({ id: 'row', sourceId: 'sample.new', title: '', mode: 'popular' });
  expect(config.tabs[0].sections[0].sourceId).toBe('old');
  act(() => model.removeSection(0, 0));
  expect(model.draft.tabs[0].sections).toHaveLength(0);
  act(() => model.restore());
  expect(model.draft.tabs[0].sections).toHaveLength(1);
  act(() => model.renameTab(0, ' '));
  await act(async () => {
    await model.submit();
  });
  expect(model.error).toEqual({ code: 'invalid_tabs' });
  expect(save).not.toHaveBeenCalled();
  act(() => model.renameTab(0, 'Valid'));
  const cause = new Error('conflict');
  save.mockRejectedValueOnce(cause);
  await act(async () => {
    await model.submit();
  });
  expect(model.error).toEqual({ code: 'save_failed', cause });
  act(() => model.addTab(newTab('Second')));
  act(() => model.moveTab(1, -1));
  expect(model.draft.tabs[0].title).toBe('Second');
  act(() => {
    model.addSection(0);
  });
  expect(model.draft.tabs[0].sections[0].sourceId).toBe('sample.new');
  await act(async () => {
    await model.submit();
  });
  expect(save).toHaveBeenLastCalledWith(model.draft, config);
  expect(close).toHaveBeenCalledOnce();
  act(() => app.unmount());
});
