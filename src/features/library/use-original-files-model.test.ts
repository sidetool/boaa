import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { useOriginalFilesModel, type OriginalFilesModel } from './use-original-files-model';
it('exposes coded failures, retries and resets pagination on refresh', async () => {
  const listOriginalFiles = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  const repository = { listOriginalFiles } as unknown as BookAssetRepository;
  let model!: OriginalFilesModel;
  function Harness() {
    model = useOriginalFilesModel({ book: { id: 'book' }, repository });
    return null;
  }
  let app!: ReturnType<typeof create>;
  await act(async () => {
    app = create(createElement(Harness));
  });
  expect(model.error).toBe('list_failed');
  act(() => model.showMore());
  expect(model.visible).toBe(60);
  await act(async () => {
    model.refresh();
  });
  expect(model.files).toEqual([]);
  expect(model.error).toBeUndefined();
  expect(model.visible).toBe(30);
  const signal = listOriginalFiles.mock.calls.at(-1)![1] as AbortSignal;
  act(() => app.unmount());
  expect(signal.aborted).toBe(true);
});
