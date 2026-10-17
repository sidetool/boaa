import { useState } from 'react';
import type { Shelf } from '../../domain/types';
import type { LibraryManagementController } from './useLibraryManagementController';
export function useShelfEditorModel(controller: LibraryManagementController) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#4f7d65');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const moveShelf = async (index: number, direction: -1 | 1) => {
    const shelf = controller.shelves[index];
    const adjacent = controller.shelves[index + direction];
    if (!shelf || !adjacent) return;
    await controller.updateShelf(shelf, { sortOrder: adjacent.sortOrder });
    await controller.updateShelf(adjacent, { sortOrder: shelf.sortOrder });
  };
  const create = () => controller.createShelf(newName, newColor).then(() => setNewName(''));
  const setDraft = (id: string, value: string) => setDrafts((old) => ({ ...old, [id]: value }));
  const rename = (shelf: Shelf) => controller.updateShelf(shelf, { name: drafts[shelf.id] ?? shelf.name });
  return {
    newName,
    setNewName,
    newColor,
    setNewColor,
    drafts,
    setDraft,
    moveShelf,
    create,
    rename,
    shelves: controller.shelves,
    busy: controller.busy,
    remove: controller.deleteShelf,
  };
}
export type ShelfEditorModel = ReturnType<typeof useShelfEditorModel>;
