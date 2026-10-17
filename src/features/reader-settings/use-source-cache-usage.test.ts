import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { readSourceMetadataCacheUsage } from '../../external-sources/local-state';
import { useSourceCacheUsage, type SourceCacheUsage } from './use-source-cache-usage';
vi.mock('../../external-sources/local-state', () => ({ readSourceMetadataCacheUsage: vi.fn() }));
it('only measures when enabled and ignores results after disabling', async () => {
  const read = vi.mocked(readSourceMetadataCacheUsage);
  let finish!: (value: { bytes: number; entries: number }) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let enabled = false,
    model!: SourceCacheUsage,
    renderer!: ReactTestRenderer;
  function Harness() {
    model = useSourceCacheUsage(enabled);
    return null;
  }
  act(() => {
    renderer = create(createElement(Harness));
  });
  expect(model.status).toBe('idle');
  expect(read).not.toHaveBeenCalled();
  enabled = true;
  act(() => renderer.update(createElement(Harness)));
  expect(model.status).toBe('loading');
  enabled = false;
  act(() => renderer.update(createElement(Harness)));
  await act(async () => {
    finish({ bytes: 100, entries: 2 });
  });
  expect(model.status).toBe('idle');
  read.mockResolvedValueOnce({ bytes: 0, entries: 0 });
  enabled = true;
  await act(async () => {
    renderer.update(createElement(Harness));
  });
  expect(model).toEqual({ status: 'ready', bytes: 0, entries: 0 });
  enabled = false;
  act(() => renderer.update(createElement(Harness)));
  read.mockRejectedValueOnce(new Error('offline'));
  enabled = true;
  await act(async () => {
    renderer.update(createElement(Harness));
  });
  expect(model.status).toBe('unavailable');
  act(() => renderer.unmount());
});
