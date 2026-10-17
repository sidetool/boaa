import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useLibraryWorkModel, type LibraryWorkModel, type LibraryWorkEdit } from './use-library-work-model';
it('validates deleted shelves, preserves failures and prevents duplicate submissions', async () => {
  const save = vi.fn().mockResolvedValue(undefined),
    close = vi.fn();
  const edit: LibraryWorkEdit = { kind: 'shelf', title: 'Book', shelfId: 'missing', save };
  let model!: LibraryWorkModel;
  function Harness() {
    model = useLibraryWorkModel({ edit, shelves: [], close });
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Harness));
  });
  await act(async () => {
    await model.submit();
  });
  expect(model.error).toEqual({ code: 'shelf_missing' });
  expect(save).not.toHaveBeenCalled();
  act(() => model.setValue(''));
  const cause = new Error('conflict');
  save.mockRejectedValueOnce(cause);
  await act(async () => {
    await model.submit();
  });
  expect(model.error).toEqual({ code: 'save_failed', cause });
  expect(close).not.toHaveBeenCalled();
  let resolve!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = model.submit();
    void model.submit();
  });
  expect(save).toHaveBeenCalledTimes(2);
  expect(model.busy).toBe(true);
  await act(async () => {
    resolve();
    await pending;
  });
  expect(close).toHaveBeenCalledOnce();
  expect(model.busy).toBe(false);
  act(() => app.unmount());
});
