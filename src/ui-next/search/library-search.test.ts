import { expect, it } from 'vitest';
import { model, novel } from '../test-fixtures';
import { orderedLibraryWorks } from '../../features/library/library-work-order';
import { searchLibrary } from './library-search';

it('searches the full catalog by title, author and tags with stable relevance and no trash', () => {
  const books = [
    ...model([
      novel({ id: 'tags', title: 'D', tags: ['Moon', 'fantasy'] }),
      novel({ id: 'author', title: 'C', author: 'Moon Writer' }),
      novel({ id: 'substring', title: 'The Moon' }),
      novel({ id: 'prefix', title: 'Moon Story' }),
      novel({ id: 'exact', title: 'Moon' }),
      novel({ id: 'trash', title: 'Moon', deletedAt: '2026-01-01' }),
    ]).collection.booksByNovelId.values(),
  ];
  const works = orderedLibraryWorks(books, [], 'added');
  expect(searchLibrary(works, '  ＭＯＯＮ ').map((item) => item.key)).toEqual([
    'book:exact',
    'book:prefix',
    'book:substring',
    'book:author',
    'book:tags',
  ]);
  expect(searchLibrary(works, 'Moon fantasy').map((item) => item.key)).toEqual(['book:tags']);
  expect(searchLibrary(works, '')).toHaveLength(5);
  expect(searchLibrary(works, 'missing')).toEqual([]);
});
