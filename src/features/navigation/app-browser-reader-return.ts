import type { BookWorkspaceController } from '../book-workspace/book-workspace-controller';
import type { BookWorkspaceState } from '../book-workspace/book-workspace-contract';

/** Reuse an actual detail entry; synthetic/source details still resolve normally. */
export async function restoreCurrentBookChapters(
  workspace: BookWorkspaceController,
  target: {
    view: BookWorkspaceState['view'];
    bookId?: string;
    detailBookId?: string;
    source?: unknown;
    chapters: Pick<BookWorkspaceState, 'chapterQuery' | 'chapterReadFilter' | 'chapterSort'>;
  },
): Promise<boolean> {
  const current = workspace.getSnapshot();
  if (
    (current.view !== 'reader' && current.view !== 'document') ||
    target.view !== 'chapters' ||
    !target.bookId ||
    current.selectedNovel?.id !== target.bookId ||
    target.detailBookId ||
    target.source
  )
    return false;
  workspace.setChapterQuery(target.chapters.chapterQuery);
  workspace.setChapterReadFilter(target.chapters.chapterReadFilter);
  workspace.setChapterSort(target.chapters.chapterSort);
  await workspace.returnToChapters();
  // Do not reopen the book after exposing the list: that late restore could
  // overwrite a new chapter click while also repeating all detail requests.
  return true;
}
