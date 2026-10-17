import { useState } from 'react';
import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import type { ExternalSourceController } from './external-source-controller-contract';
const SOURCE_FILTER_THRESHOLD = 6;
const FAVORITES_KEY = 'boaa.source-favorites.v1';
function loadFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(readBrandStorage(localStorage, FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function useExternalSourceSettingsModel(controller: Pick<ExternalSourceController, 'sources'>) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [language, setLanguage] = useState('*');
  const [state, setState] = useState('all');
  const [favorites, setFavorites] = useState(loadFavorites);
  const [error, setError] = useState(false);
  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    try {
      writeBrandStorage(localStorage, FAVORITES_KEY, JSON.stringify(next));
      setFavorites(next);
      setError(false);
    } catch {
      setError(true);
    }
  };
  const filterable = controller.sources.length > SOURCE_FILTER_THRESHOLD;
  const filtered = !filterable
    ? controller.sources
    : controller.sources.filter(
        (source) =>
          `${source.title} ${source.description ?? ''}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()) &&
          (kind === 'all' || (source.contentKind ?? 'unknown') === kind) &&
          (language === '*' || (source.lang ?? 'unknown') === language) &&
          (state === 'all' ||
            (state === 'favorite' ? favorites.includes(source.id) : source.connection.state === state)),
      );
  const languages = [
    ...new Set(controller.sources.map((source) => source.lang).filter((lang): lang is string => Boolean(lang))),
  ].sort();
  return {
    query,
    setQuery,
    kind,
    setKind,
    language,
    setLanguage,
    state,
    setState,
    favorites,
    error,
    toggleFavorite,
    filterable,
    filtered,
    languages,
    kindOptions: ['all', 'text', 'image', 'unknown'] as const,
    stateOptions: ['all', 'favorite', 'connected', 'disconnected', 'reauthorization_required', 'unavailable'] as const,
    languageOptions: ['*', ...languages, 'unknown'],
    builtIn: filtered.filter((source) => source.origin === 'built_in'),
    plugins: filtered.filter((source) => source.origin === 'plugin'),
  };
}
export type ExternalSourceSettingsModel = ReturnType<typeof useExternalSourceSettingsModel>;
