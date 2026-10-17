import type { Chapter } from '../../domain/types';
import type { ChapterAnnotationCounts } from './annotation-model';

export interface ReaderOutlinePanelProps {
  readonly chapters: readonly Chapter[];
  readonly pendingChapterIds?: ReadonlySet<string>;
  readonly filteredChapters: readonly Chapter[];
  readonly currentChapterId: string;
  readonly readChapter?: Chapter;
  readonly readChapterProgress: number;
  readonly annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly openChapter: (chapter: Chapter, restore: boolean) => Promise<void>;
}
