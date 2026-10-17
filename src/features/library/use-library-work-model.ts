import { useRef, useState } from 'react';
import type { Shelf } from '../../domain/types';
export interface LibraryWorkEdit {
  readonly kind: 'title' | 'shelf';
  readonly title: string;
  readonly shelfId?: string;
  save(value: string): Promise<void>;
}

export type LibraryWorkError = { code: 'shelf_missing' } | { code: 'save_failed'; cause: unknown };
export interface LibraryWorkModelOptions {
  edit: LibraryWorkEdit;
  shelves: readonly Shelf[];
  close(): void;
}
export function useLibraryWorkModel({ edit, shelves, close }: LibraryWorkModelOptions) {
  const [value, setValue] = useState(edit.kind === 'title' ? edit.title : (edit.shelfId ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LibraryWorkError>();
  const saving = useRef(false);
  const submit = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (edit.kind === 'shelf' && value && !shelves.some((shelf) => shelf.id === value)) {
        setError({ code: 'shelf_missing' });
        return;
      }
      await edit.save(value.trim());
      close();
    } catch (cause) {
      setError({ code: 'save_failed', cause });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return { value, setValue, busy, error, submit };
}
export type LibraryWorkModel = ReturnType<typeof useLibraryWorkModel>;
