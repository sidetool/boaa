import type { Chapter } from '../../domain/types';
import type { OpenReaderChapterOptions } from '../reader/reader-screen-contract';

/** Rebind a catalogue placeholder to the imported chapter without losing edge/anchor intent. */
export function sourceChapterOpenOptions(
  options: OpenReaderChapterOptions | undefined,
  chapter: Chapter,
): OpenReaderChapterOptions | undefined {
  if (!options?.position) return options;
  const position = options.position;
  const atEnd = position.scrollTop === Number.MAX_SAFE_INTEGER;
  return {
    ...options,
    position: {
      ...position,
      novelId: chapter.novelId,
      chapterId: chapter.id,
      ...(atEnd
        ? { paragraphId: undefined, paragraphIndex: Math.max(1, chapter.paragraphCount), offsetInParagraph: 0 }
        : {}),
    },
  };
}
