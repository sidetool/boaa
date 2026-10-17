import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import { normalizeCoverImage } from '../../services/cover-image';
import type { LibraryManagementController } from './useLibraryManagementController';
import { useMetadataEditorDraft, type MetadataEditorDraft } from './useMetadataEditorDraft';

vi.mock('../../services/cover-image', () => ({ normalizeCoverImage: vi.fn() }));
let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.restoreAllMocks();
});
function setup() {
  const book = { id: 'book', title: '기존 제목', tags: ['기존'], metadataRevision: 1 } as Novel;
  const controller = {
    panel: { kind: 'metadata', book },
    memberships: [{ bookId: book.id, shelfId: 'first' }],
    shelves: [{ id: 'first' }, { id: 'second' }, { id: 'unchanged' }],
    setMembership: vi.fn().mockResolvedValue(undefined),
    saveBookDetails: vi.fn().mockResolvedValue(undefined),
  } as unknown as LibraryManagementController;
  let draft!: MetadataEditorDraft;
  function Harness({ value }: { value: LibraryManagementController }) {
    draft = useMetadataEditorDraft(value);
    return null;
  }
  act(() => {
    renderer = create(<Harness value={controller} />);
  });
  return {
    book,
    controller,
    get draft() {
      return draft;
    },
    update(value: LibraryManagementController) {
      act(() => renderer.update(<Harness value={value} />));
    },
  };
}

it('tracks field changes and returning to the original value', () => {
  const h = setup();
  expect(h.draft.dirty).toBe(false);
  act(() => h.draft.setTitle('수정 제목'));
  expect(h.draft.dirty).toBe(true);
  act(() => h.draft.setTitle(h.book.title));
  expect(h.draft.dirty).toBe(false);
});
it('normalizes comma-separated tags, clears the input, and removes tags', () => {
  const h = setup();
  act(() => h.draft.setTagDraft(' 기존, 새 태그, , 새 태그 '));
  act(() => h.draft.addTag());
  expect(h.draft.tags).toEqual(['기존', '새 태그']);
  expect(h.draft.tagDraft).toBe('');
  expect(h.draft.dirty).toBe(true);
  act(() => h.draft.removeTag('새 태그'));
  expect(h.draft.tags).toEqual(['기존']);
  expect(h.draft.dirty).toBe(false);
});
it('saves only changed memberships followed by the metadata patch and cover action', async () => {
  const h = setup();
  act(() => h.draft.toggleShelf('first'));
  act(() => h.draft.toggleShelf('second'));
  expect([...h.draft.selectedShelfIds]).toEqual(['second']);
  expect(h.draft.dirty).toBe(true);
  act(() => {
    h.draft.setAuthor(' 새 작가 ');
    h.draft.removeCover();
  });
  await act(() => h.draft.save());
  expect(h.controller.setMembership).toHaveBeenCalledTimes(2);
  expect(h.controller.setMembership).toHaveBeenNthCalledWith(1, 'first', 'book', false);
  expect(h.controller.setMembership).toHaveBeenNthCalledWith(2, 'second', 'book', true);
  expect(h.controller.saveBookDetails).toHaveBeenCalledExactlyOnceWith(
    h.book,
    { author: '새 작가' },
    { kind: 'remove' },
  );
  expect(vi.mocked(h.controller.setMembership).mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(h.controller.saveBookDetails).mock.invocationCallOrder[0],
  );
});
it('rebases only untouched fields when the metadata revision changes', () => {
  const h = setup();
  act(() => {
    h.draft.setTitle('직접 제목');
    h.draft.setPositionX(20);
  });
  const updated = {
    ...h.book,
    metadataRevision: 2,
    title: '서버 제목',
    author: '서버 작가',
    seriesTitle: '시리즈',
    seriesIndex: 2,
    language: 'ko',
    description: '설명',
    tags: ['추가'],
    coverFit: 'contain' as const,
    coverPositionX: 80,
    coverPositionY: 30,
  };
  h.update({ ...h.controller, panel: { kind: 'metadata', book: updated } });
  expect(h.draft).toMatchObject({
    title: '직접 제목',
    author: '서버 작가',
    seriesTitle: '시리즈',
    seriesIndex: '2',
    language: 'ko',
    description: '설명',
    tags: ['추가'],
    fit: 'contain',
    positionX: 20,
    positionY: 30,
    dirty: true,
  });
});
it('keeps edited tags and ignores metadata changes without a new revision', () => {
  const h = setup();
  act(() => h.draft.removeTag('기존'));
  h.update({ ...h.controller, panel: { kind: 'metadata', book: { ...h.book, title: '다른 제목' } } });
  expect(h.draft.title).toBe('기존 제목');
  h.update({
    ...h.controller,
    panel: { kind: 'metadata', book: { ...h.book, metadataRevision: 2, tags: ['서버 태그'] } },
  });
  expect(h.draft.tags).toEqual([]);
});
it('owns replacement cover previews, synchronizes layout, and cleans object URLs', async () => {
  const h = setup();
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const blob = new Blob(['cover']);
  vi.mocked(normalizeCoverImage).mockResolvedValue({
    blob,
    fileName: 'cover.png',
    contentType: 'image/png',
    contentHash: 'cover-hash',
    pixelWidth: 1,
    pixelHeight: 1,
    fit: 'crop',
    positionX: 50,
    positionY: 50,
  });
  await act(() => h.draft.selectCover(new File(['cover'], 'cover.png')));
  expect(h.draft.coverPreviewUrl).toBe('blob:preview');
  expect(createUrl).toHaveBeenCalledWith(blob);
  act(() => {
    h.draft.setFit('contain');
    h.draft.setPositionY(30);
  });
  expect(h.draft.cover).toMatchObject({ kind: 'replace', input: { fit: 'contain', positionY: 30 } });
  act(() => h.draft.removeCover());
  expect(h.draft.coverPreviewUrl).toBeUndefined();
  expect(revokeUrl).toHaveBeenCalledWith('blob:preview');
});
it('exposes cover errors and clears busy state after normalization fails', async () => {
  const h = setup();
  vi.mocked(normalizeCoverImage).mockRejectedValue(new Error('표지 오류'));
  await act(() => h.draft.selectCover(new File([], 'cover.png')));
  expect(h.draft.coverError).toBe('표지 오류');
  expect(h.draft.coverBusy).toBe(false);
  expect(h.draft.cover).toEqual({ kind: 'keep' });
});
it('has no book and cannot save outside the metadata panel', async () => {
  const h = setup();
  h.update({ ...h.controller, panel: undefined });
  expect(h.draft.book).toBeUndefined();
  expect(h.draft.dirty).toBe(false);
  await h.draft.save();
  expect(h.controller.saveBookDetails).not.toHaveBeenCalled();
});
