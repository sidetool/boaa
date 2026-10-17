import { useRef, useState } from 'react';
import type { LibraryStorageBook, LibraryStorageUsage } from '../../domain/types';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';

export interface StorageManagement {
  readonly catalog?: LibraryCatalogRepository;
  readonly blocked: boolean;
  onChanged(): Promise<void>;
}
export type StorageBookAction = 'moveToTrash' | 'restore' | 'purge';
export type StorageBookSort = 'size' | 'name';
export interface StorageBookConfirmation {
  action: StorageBookAction;
  count: number;
  titles: readonly string[];
}
export interface StorageBookMutationResult {
  action: StorageBookAction;
  completed: number;
  remaining: number;
  refreshFailed: boolean;
}
export interface StorageBookManagerModelInput {
  usage: LibraryStorageUsage;
  management?: StorageManagement;
  refresh(): Promise<void>;
  confirm(request: StorageBookConfirmation): boolean | Promise<boolean>;
  onBusyChange?(busy: boolean): void;
  initialTrash?: boolean;
}

export function filterStorageBooks(
  books: readonly LibraryStorageBook[],
  trash: boolean,
  query: string,
  sort: StorageBookSort,
): LibraryStorageBook[] {
  return books
    .filter(
      (book) => book.trashed === trash && book.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === 'size' ? b.bytes - a.bytes || a.title.localeCompare(b.title) : a.title.localeCompare(b.title),
    );
}

export function useStorageBookManagerModel({
  usage,
  management,
  refresh,
  confirm,
  onBusyChange,
  initialTrash = false,
}: StorageBookManagerModelInput) {
  const [trash, setTrash] = useState(initialTrash);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<StorageBookSort>('size');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StorageBookMutationResult>();
  const lock = useRef(false);
  const latest = useRef(management);
  latest.current = management;
  const books = filterStorageBooks(usage.books, trash, query, sort);
  const targets = books.filter((book) => selected.has(book.id));
  const disabled = busy || !management?.catalog || management.blocked;
  const changeLocation = (value: boolean) => {
    setTrash(value);
    setSelected(new Set());
    setLimit(50);
    setResult(undefined);
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    setSelected(new Set());
    setLimit(50);
  };
  const select = (id: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const refreshList = () => {
    setSelected(new Set());
    return refresh();
  };

  async function mutate(action: StorageBookAction): Promise<StorageBookMutationResult | undefined> {
    const catalog = latest.current?.catalog;
    if (lock.current || latest.current?.blocked || !catalog || !targets.length) return;
    // Confirmation may be asynchronous: reserve this operation before awaiting it.
    lock.current = true;
    let started = false;
    try {
      const confirmation = confirm({ action, count: targets.length, titles: targets.map((book) => book.title) });
      if (!(typeof confirmation === 'boolean' ? confirmation : await confirmation)) return;
      if (latest.current?.blocked || latest.current?.catalog !== catalog) return;
      started = true;
      setBusy(true);
      onBusyChange?.(true);
      setResult(undefined);
      let completed = 0;
      for (const book of targets) {
        if (latest.current?.blocked || latest.current?.catalog !== catalog) break;
        try {
          await catalog[action](book.id, book.metadataRevision);
          completed++;
        } catch {
          /* Keep changed revisions and failed requests untouched until refresh. */
        }
      }
      setSelected(new Set());
      let outcome: StorageBookMutationResult = {
        action,
        completed,
        remaining: targets.length - completed,
        refreshFailed: false,
      };
      setResult(outcome);
      try {
        await management?.onChanged();
        await refresh();
      } catch {
        outcome = { ...outcome, refreshFailed: true };
        setResult(outcome);
      }
      return outcome;
    } finally {
      lock.current = false;
      if (started) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  return {
    trash,
    query,
    sort,
    setSort,
    limit,
    selected,
    busy,
    result,
    books,
    targets,
    disabled,
    changeLocation,
    changeQuery,
    select,
    refreshList,
    mutate,
    loadMore: () => setLimit((value) => value + 50),
    visibleBooks: books.slice(0, limit),
    selectedBytes: targets.reduce((sum, book) => sum + book.bytes, 0),
    locationCounts: {
      library: usage.books.filter((book) => !book.trashed).length,
      trash: usage.books.filter((book) => book.trashed).length,
    },
    sortOptions: ['size', 'name'] as const,
  };
}
export type StorageBookManagerModel = ReturnType<typeof useStorageBookManagerModel>;
