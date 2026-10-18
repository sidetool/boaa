import { useAccountStorage } from '../auth/use-account-storage';
import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { useState } from 'react';
import type { ReadingProfile, ReadingProfileOverride } from '../../domain/types';

const STORAGE_KEY = 'boaa.reader-theme-presets.v1';

export interface ReaderThemePreset {
  readonly id: string;
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly brightness: number;
}

function loadPresets(storage: Storage): ReaderThemePreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(readBrandStorage(storage, STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ReaderThemePreset =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ReaderThemePreset).id === 'string' &&
        typeof (item as ReaderThemePreset).name === 'string' &&
        /^#[0-9a-f]{6}$/iu.test((item as ReaderThemePreset).foreground) &&
        /^#[0-9a-f]{6}$/iu.test((item as ReaderThemePreset).background) &&
        typeof (item as ReaderThemePreset).brightness === 'number',
    );
  } catch {
    return [];
  }
}

function storePresets(presets: readonly ReaderThemePreset[], storage: Storage): boolean {
  try {
    writeBrandStorage(storage, STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

export interface ReaderThemePresetsOptions {
  readonly profile: ReadingProfile;
  readonly foreground: string;
  readonly background: string;
  readonly updateProfile: (patch: ReadingProfileOverride) => void;
}
export function useReaderThemePresets({ profile, foreground, background, updateProfile }: ReaderThemePresetsOptions) {
  const storage = useAccountStorage();
  const [presets, setPresets] = useState(() => loadPresets(storage));
  const [name, setName] = useState('');
  const [error, setError] = useState<'save_failed'>();
  const [editing, setEditing] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const duplicate = presets.some((preset) => preset.name === name.trim());
  /** Saves under the drafted name, or `named` when the view collected it itself (e.g. in a dialog). */
  const save = (confirm: (name: string) => boolean, named?: string) => {
    const trimmed = (named ?? name).trim();
    if (!trimmed) return;
    if (presets.some((preset) => preset.name === trimmed) && !confirm(trimmed)) return;
    const next = [
      ...presets.filter((preset) => preset.name !== trimmed),
      {
        id: `reader-theme-${Date.now().toString(36)}`,
        name: trimmed,
        foreground,
        background,
        brightness: profile.brightness,
      },
    ];
    if (!storePresets(next, storage)) {
      setError('save_failed');
      return;
    }
    setPresets(next);
    setName('');
    setError(undefined);
  };
  const remove = (id: string) => {
    const next = presets.filter((preset) => preset.id !== id);
    if (!storePresets(next, storage)) {
      setError('save_failed');
      return;
    }
    setPresets(next);
    setError(undefined);
  };
  const renameDuplicate = presets.some((p) => p.id !== editing && p.name === renameDraft.trim());
  const canRename = Boolean(editing && renameDraft.trim() && !renameDuplicate);
  const beginRename = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setEditing(id);
    setRenameDraft(preset.name);
  };
  const cancelRename = () => setEditing(undefined);
  /** Renames the preset being edited, or `target` directly when the view owns the draft. */
  const rename = (target?: { id: string; name: string }) => {
    const id = target?.id ?? editing;
    const draft = (target?.name ?? renameDraft).trim();
    if (!id || !draft || presets.some((p) => p.id !== id && p.name === draft)) return;
    const next = presets.map((p) => (p.id === id ? { ...p, name: draft } : p));
    if (!storePresets(next, storage)) {
      setError('save_failed');
      return;
    }
    setPresets(next);
    setEditing(undefined);
    setError(undefined);
  };
  const apply = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (preset)
      updateProfile({
        theme: 'custom',
        foreground: preset.foreground,
        background: preset.background,
        brightness: preset.brightness,
      });
  };
  return {
    presets,
    name,
    setName,
    error,
    editing,
    renameDraft,
    setRenameDraft,
    duplicate,
    renameDuplicate,
    canRename,
    save,
    remove,
    beginRename,
    cancelRename,
    rename,
    apply,
  };
}
export type ReaderThemePresetsModel = ReturnType<typeof useReaderThemePresets>;
