import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryStorageUsage } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

export interface StorageSettingsModelInput {
  assets?: BookAssetRepository;
  controller: Pick<ExternalSourceController, 'downloadRetention'>;
}
export function useStorageSettingsModel({ assets, controller }: StorageSettingsModelInput) {
  const [usage, setUsage] = useState<LibraryStorageUsage>();
  const [error, setError] = useState<'unsupported' | 'load_failed'>();
  const [loading, setLoading] = useState(false);
  const [managing, setManaging] = useState<'library' | 'trash'>();
  const generation = useRef({ value: 0 }).current;
  const refresh = useCallback(async () => {
    const request = ++generation.value;
    if (!assets?.getStorageUsage) {
      setLoading(false);
      setError('unsupported');
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await assets.getStorageUsage();
      if (request === generation.value) setUsage(result);
    } catch {
      if (request === generation.value) setError('load_failed');
    } finally {
      if (request === generation.value) setLoading(false);
    }
  }, [assets, generation]);
  useEffect(() => {
    setUsage(undefined);
    void refresh();
    return () => {
      generation.value++;
    };
  }, [refresh, generation]);
  const retention = controller.downloadRetention;
  const clean = async () => {
    await retention?.clean();
    await refresh();
  };
  return {
    usage,
    error,
    loading,
    managing,
    setManaging,
    refresh,
    retention,
    clean,
    libraryCount: usage?.books.filter((book) => !book.trashed).length ?? 0,
    trashCount: usage?.books.filter((book) => book.trashed).length ?? 0,
    cleanupSectionCount: retention?.preview?.reduce((sum, item) => sum + item.sections.length, 0) ?? 0,
  };
}
export type StorageSettingsModel = ReturnType<typeof useStorageSettingsModel>;
