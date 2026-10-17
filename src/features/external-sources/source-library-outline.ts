import type { ReaderOutlinePanelProps } from '../annotations/reader-outline-contract';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import type { SourceLibraryReader } from './use-source-library-reader';
import { filterOutlineChapters } from '../book-workspace/book-workspace-projection';
import { openSourceLibraryChapter } from './source-library-reader-model';
import { externalItemSectionId } from './serial-work-projection';

/** Adapts only the active source catalogue. Placeholder IDs stay out of persisted reading/annotation lookups. */
export function sourceLibraryOutline(
  props: ReaderOutlinePanelProps,
  model: ReaderScreenModel | undefined,
  source?: SourceLibraryReader,
  onSourceOpened?: () => void,
): ReaderOutlinePanelProps {
  if (
    !model ||
    !source ||
    source.novelId !== model.novel.id ||
    !source.items.some((item) => externalItemSectionId(item) === model.chapter.documentSectionId)
  )
    return props;
  const chapters = model.chapters;
  const pendingChapterIds = new Set(
    chapters.filter((chapter) => chapter.id.startsWith('source-pending:')).map((chapter) => chapter.id),
  );
  const readChapter =
    props.readChapter && !pendingChapterIds.has(props.readChapter.id)
      ? chapters.find((chapter) => chapter.id === props.readChapter!.id)
      : undefined;
  return {
    ...props,
    chapters,
    filteredChapters: filterOutlineChapters(chapters, props.query),
    pendingChapterIds,
    readChapter,
    readChapterProgress: readChapter ? props.readChapterProgress : 0,
    annotationCounts: new Map([...props.annotationCounts].filter(([id]) => !pendingChapterIds.has(id))),
    openChapter: (chapter, restore) =>
      openSourceLibraryChapter(chapter, source, () => props.openChapter(chapter, restore), onSourceOpened),
  };
}
