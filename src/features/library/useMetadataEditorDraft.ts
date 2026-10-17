import { useEffect, useMemo, useRef, useState } from 'react';
import type { Novel } from '../../domain/types';
import { normalizeCoverImage } from '../../services/cover-image';
import type { CoverDraftAction, LibraryManagementController } from './useLibraryManagementController';
import { buildMetadataPatch, normalizeMetadataTags } from './metadata-editor-draft';

export interface MetadataEditorDraft {
  readonly book?: Novel;
  readonly title: string;
  setTitle(v: string): void;
  readonly author: string;
  setAuthor(v: string): void;
  readonly seriesTitle: string;
  setSeriesTitle(v: string): void;
  readonly seriesIndex: string;
  setSeriesIndex(v: string): void;
  readonly language: string;
  setLanguage(v: string): void;
  readonly description: string;
  setDescription(v: string): void;
  readonly tagDraft: string;
  setTagDraft(v: string): void;
  readonly tags: readonly string[];
  addTag(): void;
  removeTag(tag: string): void;
  readonly fit: 'crop' | 'contain';
  setFit(v: 'crop' | 'contain'): void;
  readonly positionX: number;
  setPositionX(v: number): void;
  readonly positionY: number;
  setPositionY(v: number): void;
  readonly cover: CoverDraftAction;
  readonly coverPreviewUrl?: string;
  readonly coverBusy: boolean;
  readonly coverError?: string;
  selectCover(file?: File): Promise<void>;
  removeCover(): void;
  readonly selectedShelfIds: ReadonlySet<string>;
  toggleShelf(shelfId: string): void;
  readonly dirty: boolean;
  save(): Promise<void>;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Metadata draft and cover lifecycle. Mount a fresh editor when switching books, as the classic panel does. */
export function useMetadataEditorDraft(controller: LibraryManagementController): MetadataEditorDraft {
  const book = controller.panel?.kind === 'metadata' ? controller.panel.book : undefined;
  const [title, setTitle] = useState(book?.title ?? '');
  const [author, setAuthor] = useState(book?.author ?? '');
  const [seriesTitle, setSeriesTitle] = useState(book?.seriesTitle ?? '');
  const [seriesIndex, setSeriesIndex] = useState(book?.seriesIndex?.toString() ?? '');
  const [tags, setTags] = useState(() => normalizeMetadataTags(book?.tags ?? []));
  const [tagDraft, setTagDraft] = useState('');
  const [description, setDescription] = useState(book?.description ?? '');
  const [language, setLanguage] = useState(book?.language ?? '');
  const [fit, setFit] = useState<'crop' | 'contain'>(book?.coverFit ?? 'crop');
  const [positionX, setPositionX] = useState(book?.coverPositionX ?? 50);
  const [positionY, setPositionY] = useState(book?.coverPositionY ?? 50);
  const [cover, setCover] = useState<CoverDraftAction>({ kind: 'keep' });
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string>();
  const [selectedShelfIds, setSelectedShelfIds] = useState<Set<string>>(
    () => new Set(controller.memberships.filter((item) => item.bookId === book?.id).map((item) => item.shelfId)),
  );
  const baseBookRef = useRef(book);
  useEffect(() => {
    const previous = baseBookRef.current;
    if (!book || !previous || book.id !== previous.id) {
      baseBookRef.current = book;
      return;
    }
    if ((book.metadataRevision ?? 0) === (previous.metadataRevision ?? 0)) return;
    setTitle((current) => (current === previous.title ? book.title : current));
    setAuthor((current) => (current === (previous.author ?? '') ? (book.author ?? '') : current));
    setSeriesTitle((current) => (current === (previous.seriesTitle ?? '') ? (book.seriesTitle ?? '') : current));
    setSeriesIndex((current) =>
      current === (previous.seriesIndex?.toString() ?? '') ? (book.seriesIndex?.toString() ?? '') : current,
    );
    setTags((current) =>
      JSON.stringify(normalizeMetadataTags(current)) === JSON.stringify(normalizeMetadataTags(previous.tags ?? []))
        ? normalizeMetadataTags(book.tags ?? [])
        : current,
    );
    setDescription((current) => (current === (previous.description ?? '') ? (book.description ?? '') : current));
    setLanguage((current) => (current === (previous.language ?? '') ? (book.language ?? '') : current));
    if (cover.kind === 'keep') {
      setFit((current) => (current === (previous.coverFit ?? 'crop') ? (book.coverFit ?? 'crop') : current));
      setPositionX((current) => (current === (previous.coverPositionX ?? 50) ? (book.coverPositionX ?? 50) : current));
      setPositionY((current) => (current === (previous.coverPositionY ?? 50) ? (book.coverPositionY ?? 50) : current));
    }
    baseBookRef.current = book;
  }, [book, cover.kind]);
  const initialShelfIds = useMemo(
    () => new Set(controller.memberships.filter((item) => item.bookId === book?.id).map((item) => item.shelfId)),
    [book?.id, controller.memberships],
  );
  const metadataPatch = book
    ? buildMetadataPatch(
        book,
        { title, author, seriesTitle, seriesIndex, tags, description, language, fit, positionX, positionY },
        cover.kind,
      )
    : {};
  const dirty = Boolean(
    book &&
    (Object.keys(metadataPatch).length > 0 || cover.kind !== 'keep' || !sameIds(initialShelfIds, selectedShelfIds)),
  );

  useEffect(() => {
    setCover((current) =>
      current.kind === 'replace'
        ? { kind: 'replace', input: { ...current.input, fit, positionX, positionY } }
        : current,
    );
  }, [fit, positionX, positionY]);

  const previewUrl = useMemo(
    () => (cover.kind === 'replace' ? URL.createObjectURL(cover.input.blob) : undefined),
    [cover],
  );
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const selectCover = async (file?: File) => {
    if (!file) return;
    setCoverBusy(true);
    setCoverError(undefined);
    try {
      setCover({ kind: 'replace', input: await normalizeCoverImage(file, { fit, positionX, positionY }) });
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '표지를 처리하지 못했습니다.');
    } finally {
      setCoverBusy(false);
    }
  };

  const save = async () => {
    if (!book) return;
    const previous = new Set(
      controller.memberships
        .filter((membership) => membership.bookId === book.id)
        .map((membership) => membership.shelfId),
    );
    for (const shelf of controller.shelves) {
      const included = selectedShelfIds.has(shelf.id);
      if (included !== previous.has(shelf.id)) await controller.setMembership(shelf.id, book.id, included);
    }
    await controller.saveBookDetails(book, metadataPatch, cover);
  };

  const addTag = () => {
    const additions = tagDraft.split(',');
    const next = normalizeMetadataTags([...tags, ...additions]);
    setTagDraft('');
    if (next.length === tags.length) return;
    setTags(next);
  };

  const toggleShelf = (shelfId: string) => {
    const next = new Set(selectedShelfIds);
    if (next.has(shelfId)) next.delete(shelfId);
    else next.add(shelfId);
    setSelectedShelfIds(next);
  };

  const removeTag = (tag: string) => setTags(tags.filter((item) => item !== tag));
  const removeCover = () => setCover({ kind: 'remove' });
  return {
    book,
    title,
    setTitle,
    author,
    setAuthor,
    seriesTitle,
    setSeriesTitle,
    seriesIndex,
    setSeriesIndex,
    language,
    setLanguage,
    description,
    setDescription,
    tags,
    tagDraft,
    setTagDraft,
    addTag,
    removeTag,
    fit,
    setFit,
    positionX,
    setPositionX,
    positionY,
    setPositionY,
    cover,
    coverBusy,
    coverError,
    selectCover,
    removeCover,
    selectedShelfIds,
    toggleShelf,
    dirty,
    save,
    coverPreviewUrl: previewUrl,
  };
}
