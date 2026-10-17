import { expect, it, vi } from 'vitest';
import type { LibraryFolderController } from './useLibraryFolderController';
import { createLibraryFolderPanelModel, folderSizeBytes, isActionable } from './library-folder-panel-model';
it('normalizes size input, projects actionable selection, and injects removal confirmation', async () => {
  expect(folderSizeBytes('')).toBeUndefined();
  expect(folderSizeBytes('NaN')).toBeUndefined();
  expect(folderSizeBytes('-1')).toBe(0);
  expect(folderSizeBytes('1.5')).toBe(1572864);
  expect(isActionable('update-existing')).toBe(true);
  expect(isActionable('missing')).toBe(false);
  const controller = {
    activeFolder: { filter: { formats: ['text', 'epub'] } },
    candidates: [
      { status: 'new', selected: true },
      { status: 'changed', selected: false },
      { status: 'missing', selected: true },
    ],
    updateFilter: vi.fn(),
    removeActiveFolder: vi.fn(),
  } as unknown as LibraryFolderController;
  const model = createLibraryFolderPanelModel(controller);
  expect(model.selectedCount).toBe(1);
  expect(model.actionable).toHaveLength(2);
  model.setFormat('text', false);
  expect(controller.updateFilter).toHaveBeenCalledWith({ formats: ['epub'] });
  model.setSize('maxBytes', '2');
  expect(controller.updateFilter).toHaveBeenCalledWith({ maxBytes: 2097152 });
  await model.remove(() => false);
  expect(controller.removeActiveFolder).not.toHaveBeenCalled();
  await model.remove(async () => true);
  expect(controller.removeActiveFolder).toHaveBeenCalledOnce();
});
