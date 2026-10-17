import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useStorageSettingsModel, type StorageSettingsModel } from './use-storage-settings-model';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { LibraryStorageUsage } from '../../domain/types';

it('ignores obsolete usage results and exposes refresh errors without losing the last usage', async () => {
  const pending: ((value: LibraryStorageUsage) => void)[] = [];
  const getStorageUsage = vi.fn(() => new Promise<LibraryStorageUsage>((resolve) => pending.push(resolve)));
  const assets = { getStorageUsage } as unknown as BookAssetRepository;
  let model!: StorageSettingsModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useStorageSettingsModel({ assets, controller: {} });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  expect(model.loading).toBe(true);
  let refreshed!: Promise<void>;
  act(() => {
    refreshed = model.refresh();
  });
  const latest: LibraryStorageUsage = {
    totalBytes: 20,
    libraryBytes: 10,
    trashBytes: 10,
    books: [false, true].map((trashed, index) => ({
      id: String(index),
      title: String(index),
      metadataRevision: 1,
      bytes: 10,
      trashed,
    })),
  };
  await act(async () => {
    pending[1](latest);
    await refreshed;
  });
  await act(async () => {
    pending[0]({ ...latest, totalBytes: 1 });
  });
  expect(model.usage?.totalBytes).toBe(20);
  expect([model.libraryCount, model.trashCount]).toEqual([1, 1]);
  getStorageUsage.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await model.refresh();
  });
  expect(model.error).toBe('load_failed');
  expect(model.usage).toBe(latest);
  expect(model.loading).toBe(false);
  act(() => renderer.unmount());
});

it('exposes an unsupported state without a storage repository', async () => {
  let model!: StorageSettingsModel;
  let renderer!: ReactTestRenderer;
  function Harness() {
    model = useStorageSettingsModel({ controller: {} });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  expect(model.error).toBe('unsupported');
  expect(model.loading).toBe(false);
  act(() => renderer.unmount());
});
