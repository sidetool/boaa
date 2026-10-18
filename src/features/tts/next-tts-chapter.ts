import type { Chapter, Novel } from '../../domain/types';
import { nextPlaybackChapter } from '../../providers/book-playback-coordinator';
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
