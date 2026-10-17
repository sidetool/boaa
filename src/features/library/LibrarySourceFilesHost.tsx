import { lazy, Suspense, useSyncExternalStore } from 'react';
import type { LibrarySourceFilesController } from './library-source-files-controller';
const OriginalFilesDialog = lazy(() =>
  import('../../ui-next/library-tools/UiNextOriginalFilesSheet').then((module) => ({
    default: module.UiNextOriginalFilesSheet,
  })),
);

export function LibrarySourceFilesHost({ controller }: { readonly controller: LibrarySourceFilesController }) {
  const book = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!book || !controller.ports.assets) return null;
  return (
    <Suspense fallback={null}>
      <OriginalFilesDialog
        book={book}
        repository={controller.ports.assets}
        onClose={controller.close}
        onLegacyExport={() => {
          void controller.exportDialogLegacy();
        }}
      />
    </Suspense>
  );
}
