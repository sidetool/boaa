import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { LibraryManagementController } from './useLibraryManagementController';
import { useShelfEditorModel, type ShelfEditorModel } from './use-shelf-editor-model';
it('creates, renames and swaps adjacent shelf orders while ignoring boundaries', async () => {
  const shelves = [
    { id: 'a', name: 'A', sortOrder: 1 },
    { id: 'b', name: 'B', sortOrder: 2 },
  ];
  const controller = {
    shelves,
    createShelf: vi.fn().mockResolvedValue(undefined),
    updateShelf: vi.fn().mockResolvedValue(undefined),
  } as unknown as LibraryManagementController;
  let model!: ShelfEditorModel;
  function Harness() {
    model = useShelfEditorModel(controller);
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Harness));
  });
  act(() => {
    model.setNewName('New');
    model.setNewColor('#123456');
  });
  await act(async () => {
    await model.create();
  });
  expect(controller.createShelf).toHaveBeenCalledWith('New', '#123456');
  expect(model.newName).toBe('');
  act(() => model.setDraft('a', 'Renamed'));
  await act(async () => {
    await model.rename(controller.shelves[0]);
    await model.moveShelf(0, -1);
  });
  expect(controller.updateShelf).toHaveBeenCalledTimes(1);
  expect(controller.updateShelf).toHaveBeenCalledWith(shelves[0], { name: 'Renamed' });
  await act(async () => {
    await model.moveShelf(0, 1);
  });
  expect(controller.updateShelf).toHaveBeenNthCalledWith(2, shelves[0], { sortOrder: 2 });
  expect(controller.updateShelf).toHaveBeenNthCalledWith(3, shelves[1], { sortOrder: 1 });
  act(() => app.unmount());
});
