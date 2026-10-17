import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { useSourceQuickJumpModel, type SourceQuickJumpModel } from './use-source-quick-jump-model';
it('filters names and selects the source kind input without closing a rejected jump', async () => {
  const sources: ExternalSourceView[] = [
    { id: 'sample.catalog', title: 'Catalog', kind: 'catalog', origin: 'plugin', connection: { state: 'connected' } },
    { id: 'sample.cloud', title: 'Cloud', kind: 'cloud_file', origin: 'plugin', connection: { state: 'connected' } },
  ];
  const open = vi.fn().mockResolvedValue(false),
    close = vi.fn();
  let model!: SourceQuickJumpModel;
  function Harness() {
    model = useSourceQuickJumpModel({ sources, open, close });
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Harness));
  });
  act(() => model.setQuery(' CATALOG '));
  expect(model.matches).toEqual([sources[0]]);
  await model.jump(sources[0]);
  expect(open).toHaveBeenLastCalledWith('sample.catalog', { browseMode: 'popular' });
  expect(close).not.toHaveBeenCalled();
  open.mockResolvedValue(undefined);
  await model.jump(sources[1]);
  expect(open).toHaveBeenLastCalledWith('sample.cloud', {});
  expect(close).toHaveBeenCalledOnce();
  act(() => app.unmount());
});
