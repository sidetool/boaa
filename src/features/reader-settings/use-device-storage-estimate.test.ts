import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useDeviceStorageEstimate, type DeviceStorageEstimateModel } from './use-device-storage-estimate';
import { formatStorageBytes } from './DeviceStorageEstimate';
afterEach(() => vi.unstubAllGlobals());
it('ignores stale estimates, clamps percentages and exposes failures', async () => {
  const pending: ((value: StorageEstimate) => void)[] = [];
  const estimate = vi.fn(() => new Promise<StorageEstimate>((resolve) => pending.push(resolve)));
  vi.stubGlobal('navigator', { storage: { estimate } });
  let model!: DeviceStorageEstimateModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useDeviceStorageEstimate();
    return null;
  }
  act(() => {
    renderer = create(createElement(Harness));
  });
  let refreshed!: Promise<void>;
  act(() => {
    refreshed = model.refresh();
  });
  await act(async () => {
    pending[1]({ usage: 200, quota: 100 });
    await refreshed;
  });
  await act(async () => {
    pending[0]({ usage: 1, quota: 100 });
  });
  expect(model.usage).toBe(200);
  expect(model.ratio).toBe(100);
  estimate.mockRejectedValueOnce(new Error('denied'));
  await act(async () => {
    await model.refresh();
  });
  expect(model.unavailable).toBe(true);
  expect(model.loading).toBe(false);
  expect(model.ratio).toBeUndefined();
  act(() => renderer.unmount());
});
it('reports unsupported browsers and preserves the formatter export', async () => {
  vi.stubGlobal('navigator', {});
  let model!: DeviceStorageEstimateModel;
  function Harness() {
    model = useDeviceStorageEstimate();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  expect(model.unavailable).toBe(true);
  expect(model.loading).toBe(false);
  expect(formatStorageBytes(1024)).toBe('1.0 KiB');
  expect(formatStorageBytes()).toBe('—');
  act(() => renderer.unmount());
});
