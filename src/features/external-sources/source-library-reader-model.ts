import type { Chapter } from '../../domain/types';
import type { ReaderScreenModel, OpenReaderChapterOptions } from '../reader/reader-screen-contract';
import type { SourceLibraryReader } from './use-source-library-reader';
import { externalItemSectionId } from './serial-work-projection';

/** Presentation-only catalog chapters; remote placeholders are never passed to the repository. */
export function sourceLibraryReaderModel(model: ReaderScreenModel, source?: SourceLibraryReader): ReaderScreenModel {
  if (!source || source.novelId !== model.novel.id) return model;
  const navigation = {
    busy: source.busy,
    pending: source.pending,
    error: source.error,
    retry: () => void source.retry(),
  };
  if (!source.items.length) return { ...model, chapters: [model.chapter], navigation };
  const index = source.items.findIndex((item) => externalItemSectionId(item) === model.chapter.documentSectionId);
  if (index < 0) return { ...model, chapters: [model.chapter], navigation };
  const chapters = source.items.map((item, i): Chapter => {
    const section = externalItemSectionId(item);
    const saved = model.chapters.find((chapter) => chapter.documentSectionId === section);
    return {
      ...(saved ?? model.chapter),
      id: saved?.id ?? `source-pending:${section}`,
      index: i + 1,
      title: item.release?.title ?? item.title,
      documentSectionId: section,
      paragraphCount: saved?.paragraphCount ?? 0,
    };
  });
  return {
    ...model,
    novel: { ...model.novel, totalChapters: chapters.length },
    chapter: chapters[index],
    chapters,
    navigation,
  };
}
/** Opens remote sections through the durable download queue; local books use the unchanged fallback. */
export async function openSourceLibraryChapter(
  chapter: Chapter,
  source: SourceLibraryReader | undefined,
  fallback: () => Promise<void>,
  onSourceOpened?: () => void,
  options?: OpenReaderChapterOptions,
): Promise<void> {
  if (chapter.novelId === source?.novelId && !source.items.length) return;
  const item =
    chapter.novelId === source?.novelId
      ? source.items.find((item) => externalItemSectionId(item) === chapter.documentSectionId)
      : undefined;
  if (item && source) {
    if ((await (options ? source.open(item, options) : source.open(item))) !== false) onSourceOpened?.();
  } else if (chapter.novelId !== source?.novelId) await fallback();
}
