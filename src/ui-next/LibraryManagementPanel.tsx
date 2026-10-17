import { lazy } from 'react';
import type { BookEnrichmentController } from '../features/book-enrichment/useBookEnrichmentController';
import type { LibraryManagementController } from '../features/library/useLibraryManagementController';

type Props = { controller: LibraryManagementController; bookEnrichment: BookEnrichmentController };

const Shelves = lazy(() => import('./library-tools/UiNextShelfSheet'));
const Metadata = lazy(() =>
  import('./library/UiNextMetadataEditor').then((module) => ({ default: module.UiNextMetadataEditor })),
);

// The workspace lazy-loads metadata editing and the shared shelf editor independently.
export default function LibraryManagementPanel(props: Props) {
  if (props.controller.panel?.kind === 'metadata') return <Metadata key={props.controller.panel.book.id} {...props} />;
  return <Shelves {...props} />;
}
