import { knownWorkTitle } from '../external-sources/source-work-metadata';
import type { ExternalSourceLibraryWork } from '../external-sources/external-source-controller-contract';
import type { LibraryBookView, LibraryCollectionModel } from './library-screen-model';

export function withSourceMetadata(
  book: LibraryBookView,
  works: readonly ExternalSourceLibraryWork[],
): LibraryBookView {
  const work = works.find((work) => work.localBookId === book.novel.id);
  if (!work) return book;
  const title = knownWorkTitle([book.novel.title, work.title], [work.collectionRemoteId, work.navigationRef]);
  return {
    ...book,
    titleUnknown: !title,
    requestMetadata: work.requestMetadata,
    novel: { ...book.novel, title: title ?? '', author: book.novel.author ?? work.author },
  };
}
export function applySourceMetadata(
  collection: LibraryCollectionModel,
  works: readonly ExternalSourceLibraryWork[],
): LibraryCollectionModel {
  const booksByNovelId = new Map(
    [...collection.booksByNovelId].map(([id, book]) => [id, withSourceMetadata(book, works)]),
  );
  const apply = (book: LibraryBookView) => booksByNovelId.get(book.novel.id) ?? withSourceMetadata(book, works);
  return {
    ...collection,
    booksByNovelId,
    visibleBooks: collection.visibleBooks.map(apply),
    recentBooks: collection.recentBooks.map(apply),
    featuredBook: collection.featuredBook && apply(collection.featuredBook),
  };
}
