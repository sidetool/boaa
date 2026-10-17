import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { ExternalSourceController } from './external-source-controller-contract';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { sourceWorkReadingSeconds } from './source-work-reading-time';
import { useSourceWorkManagementModel, type SourceWorkManagementModel } from './use-source-work-management-model';
vi.mock('./source-work-reading-time', () => ({ sourceWorkReadingSeconds: vi.fn().mockResolvedValue(42) }));
it('loads scoped reading time and closes after removing an owned work', async () => {
  const controller = {
    workReadingSessionId: 'work',
    readingHistoryRevision: 1,
    close: vi.fn(),
    resetCurrentWorkHistory: vi.fn(),
  } as unknown as ExternalSourceController;
  const remove = vi.fn().mockResolvedValue(undefined);
  const library = { actions: { books: { remove } } } as unknown as LibraryScreenProps;
  const novel = { id: 'book' } as Novel;
  let model!: SourceWorkManagementModel;
  function Harness() {
    model = useSourceWorkManagementModel({ novel, controller, library });
    return null;
  }
  let app!: ReturnType<typeof create>;
  await act(async () => {
    app = create(createElement(Harness));
  });
  expect(sourceWorkReadingSeconds).toHaveBeenCalledWith('work');
  expect(model.seconds).toBe(42);
  await model.remove();
  expect(remove).toHaveBeenCalledWith(novel);
  expect(controller.close).toHaveBeenCalledOnce();
  model.resetHistory();
  expect(controller.resetCurrentWorkHistory).toHaveBeenCalledOnce();
  act(() => app.unmount());
});
