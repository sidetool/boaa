import { useRef, useState } from 'react';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { ExternalSourceListInput } from '../../external-sources/contracts';
export interface SourceQuickJumpModelOptions {
  sources: readonly ExternalSourceView[];
  close(): void;
  open(source: string, input: ExternalSourceListInput): void | boolean | Promise<void | boolean>;
}
export function useSourceQuickJumpModel({ sources, close, open }: SourceQuickJumpModelOptions) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const matches = sources.filter((source) =>
    source.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const jump = async (source: ExternalSourceView) => {
    if ((await open(source.id, source.kind === 'cloud_file' ? {} : { browseMode: 'popular' })) !== false) close();
  };
  return { query, setQuery, search, matches, jump };
}
export type SourceQuickJumpModel = ReturnType<typeof useSourceQuickJumpModel>;
