import { LIBRARY_FOLDER_FORMATS, type LibraryFolderCandidateStatus } from '../../library-folders/contracts';
import type { LibraryFolderController } from './useLibraryFolderController';
export function isActionable(status: LibraryFolderCandidateStatus): boolean {
  return status === 'new' || status === 'changed' || status === 'update-existing';
}

export function folderSizeBytes(input: string): number | undefined {
  const value = Number(input);
  return input && Number.isFinite(value) ? Math.max(0, value) * 1024 * 1024 : undefined;
}
export function createLibraryFolderPanelModel(controller: LibraryFolderController) {
  const folder = controller.activeFolder;
  const actionable = controller.candidates.filter((candidate) => isActionable(candidate.status));
  const selectedCount = actionable.filter((candidate) => candidate.selected).length;

  const remove = async (confirm: () => boolean | Promise<boolean>) => {
    if (await confirm()) await controller.removeActiveFolder();
  };
  const setFormat = (format: (typeof LIBRARY_FOLDER_FORMATS)[number], checked: boolean) => {
    if (!folder) return;
    return controller.updateFilter({
      formats: checked ? [...folder.filter.formats, format] : folder.filter.formats.filter((item) => item !== format),
    });
  };
  const setSize = (kind: 'minBytes' | 'maxBytes', value: string) =>
    controller.updateFilter({ [kind]: folderSizeBytes(value) });
  return { folder, actionable, selectedCount, remove, setFormat, setSize, formats: LIBRARY_FOLDER_FORMATS };
}
export type LibraryFolderPanelModel = ReturnType<typeof createLibraryFolderPanelModel>;
