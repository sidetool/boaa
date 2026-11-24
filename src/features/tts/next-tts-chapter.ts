import type { Chapter, Novel } from '../../domain/types';
import { type BookPlaybackCoordinator, nextPlaybackChapter } from '../../providers/book-playback-coordinator';
import type { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import type { BookWorkspaceReaderOpenOptions } from '../book-workspace/book-workspace-contract';
export interface PreparedTTSChapter {
  novel: Novel;
  chapter: Chapter;
  chapters?: Chapter[];
}
/** Source catalog order wins over the subset already downloaded into the local outline. */
export async function prepareNextTTSChapter(input: {
  novel: Novel;
  current: Chapter;
  listChapters(bookId: string): Promise<Chapter[]>;
  source?: {
    novelId: string;
    items: readonly { sectionId: string; prepare(): Promise<PreparedTTSChapter | undefined> }[];
  };
}): Promise<PreparedTTSChapter | undefined> {
  if (input.source?.novelId === input.novel.id) {
    const index = input.source.items.findIndex((item) => item.sectionId === input.current.documentSectionId);
    if (index < 0) throw new Error('다음 화 목록을 아직 준비하지 못했습니다. 잠시 후 다시 재생해 주세요.');
    const next = input.source.items[index + 1];
    if (!next) return;
    const prepared = await next.prepare();
    if (
      !prepared ||
      prepared.novel.id !== input.novel.id ||
      prepared.chapter.novelId !== input.novel.id ||
      prepared.chapter.documentSectionId !== next.sectionId ||
      prepared.chapter.id === input.current.id
    )
      throw new Error('다음 화를 준비하지 못했습니다. 연결을 확인하고 다시 재생해 주세요.');
    return prepared;
  }
  const chapters = await input.listChapters(input.novel.id);
  const chapter = nextPlaybackChapter(chapters, input.current.id);
  return chapter ? { novel: input.novel, chapter } : undefined;
}

/** Resume the requested audio position as soon as its chapter commits to the reader. */
export async function openChapterForPlayback(
  coordinator: BookPlaybackCoordinator,
  workspace: Pick<BookWorkspaceController, 'openChapter' | 'getSnapshot'>,
  { novel, chapter, chapters }: PreparedTTSChapter,
  options: {
    listeningMode: NonNullable<BookWorkspaceReaderOpenOptions['listeningMode']>;
    startIndex: number;
    queueItemFingerprint?: string;
    preserveTTS?: boolean;
  },
): Promise<void> {
  const generation = coordinator.schedule({
    bookId: novel.id,
    chapterId: chapter.id,
    startIndex: options.startIndex,
    queueItemFingerprint: options.queueItemFingerprint,
  });
  if (workspace.getSnapshot().currentChapter?.id === chapter.id) return;
  try {
    await workspace.openChapter(chapter, {
      novel,
      chapters,
      listeningMode: options.listeningMode,
      preserveTTS: options.preserveTTS,
    });
  } finally {
    if (coordinator.currentGeneration === generation && workspace.getSnapshot().currentChapter?.id !== chapter.id)
      coordinator.cancel();
  }
}
