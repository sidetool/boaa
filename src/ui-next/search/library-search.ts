import type { LibraryWorkItem } from '../../features/library/library-work-order';

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
/** Exact title, title prefix, title substring, author, then tags; stable catalog order breaks ties. */
export function searchLibrary(items: readonly LibraryWorkItem[], query: string): readonly LibraryWorkItem[] {
  const needle = normalized(query);
  const tokens = needle.split(' ').filter(Boolean);
  return items
    .flatMap((item, index) => {
      const work = item.kind === 'book' ? item.book.novel : item.work;
      if (work.deletedAt) return [];
      const title = normalized(work.title);
      const author = normalized(work.author ?? '');
      const tags = 'tags' in work && Array.isArray(work.tags) ? work.tags.map(normalized) : [];
      if (!tokens.every((token) => [title, author, ...tags].some((field) => field.includes(token)))) return [];
      const score = !needle
        ? 0
        : title === needle
          ? 100
          : title.startsWith(needle)
            ? 80
            : title.includes(needle)
              ? 60
              : author.includes(needle)
                ? 40
                : 20;
      return [{ item, index, score }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}
