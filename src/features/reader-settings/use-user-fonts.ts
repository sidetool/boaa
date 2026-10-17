import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserFontAsset } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { unloadUserFont } from './user-font-runtime';
import { prepareUserFont, verifyFontCanLoad } from './user-font-service';

export type UserFontError = 'duplicate' | 'size_invalid' | 'save_failed' | 'load_failed' | 'format_invalid';
export interface UserFontsOptions {
  readonly repository?: ReaderPersonalizationRepository;
  readonly activeFontId: string;
  selectFont(id: string): void;
}
export function useUserFonts({ repository, activeFontId, selectFont }: UserFontsOptions) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fonts, setFonts] = useState<UserFontAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserFontError>();
  const refresh = useCallback(() => {
    if (!repository) return Promise.resolve();
    return repository.listUserFonts().then(setFonts);
  }, [repository]);

  const [operationError, setOperationError] = useState<'list_failed' | 'rename_failed' | 'remove_failed'>();
  useEffect(() => {
    void refresh().catch(() => setOperationError('list_failed'));
  }, [refresh]);

  const install = async (file: File) => {
    if (!repository) return;
    setBusy(true);
    setError(undefined);
    let phase: 'prepare' | 'load' | 'save' = 'prepare';
    try {
      const prepared = await prepareUserFont(file);
      if (fonts.some((font) => font.contentHash === prepared.asset.contentHash)) {
        throw new Error('font_duplicate');
      }
      phase = 'load';
      await verifyFontCanLoad(prepared.asset, prepared.blob);
      phase = 'save';
      await repository.installUserFont(prepared);
      await refresh();
      selectFont(prepared.asset.id);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(
        code === 'font_duplicate'
          ? 'duplicate'
          : code === 'font_size_invalid'
            ? 'size_invalid'
            : phase === 'save'
              ? 'save_failed'
              : phase === 'load'
                ? 'load_failed'
                : 'format_invalid',
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const rename = async (id: string, name: string) => {
    const font = fonts.find((font) => font.id === id);
    const familyLabel = name.trim();
    if (!repository || !font || !familyLabel) return;
    setOperationError(undefined);
    try {
      await repository.updateUserFont(id, { familyLabel, licenseNote: font.licenseNote });
      await refresh();
    } catch {
      setOperationError('rename_failed');
    }
  };
  const remove = async (id: string) => {
    if (!repository) return;
    setOperationError(undefined);
    if (activeFontId === id) selectFont('builtin-serif');
    unloadUserFont(id);
    try {
      await repository.deleteUserFont(id);
      await refresh();
    } catch {
      setOperationError('remove_failed');
    }
  };
  return { fonts, busy, error, operationError, install, rename, remove, inputRef, refresh };
}
export type UserFontsModel = ReturnType<typeof useUserFonts>;
