import { randomUuid } from '../../utils/random-uuid';
import { useState } from 'react';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { DiscoveryController } from './useDiscoveryController';
export type SaveDiscoveryListError = { code: 'section_limit'; limit: number } | { code: 'save_failed'; cause: unknown };
export interface SaveDiscoveryListModelOptions {
  discovery: DiscoveryController;
  source: ExternalSourceController;
  close(): void;
}
export function useSaveDiscoveryListModel({ discovery, source, close }: SaveDiscoveryListModelOptions) {
  const [target, setTarget] = useState(
    discovery.config.tabs.find((t) => !t.hidden)?.id ?? discovery.config.tabs[0]?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveDiscoveryListError>();
  const browse = source.browse;
  const submit = async () => {
    if (!browse || !source.activeSourceId) return;
    const next = structuredClone(discovery.config);
    const tab = next.tabs.find((t) => t.id === target);
    if (!tab) return;
    if (tab.sections.length >= 60) {
      setError({ code: 'section_limit', limit: 60 });
      return;
    }
    tab.sections.push({
      id: randomUuid(),
      sourceId: source.activeSourceId,
      title: title.trim(),
      mode: browse.activeMode === 'latest' ? 'latest' : 'popular',
      parentRef: source.breadcrumbs.at(-1)?.parentRef,
      filters: (browse.filters ?? []).flatMap((f) =>
        'defaultValue' in f
          ? [
              {
                position: f.position,
                groupPosition: f.groupPosition,
                value: source.filterValues[f.id] ?? f.defaultValue,
              },
            ]
          : [],
      ),
      filterSignature: JSON.stringify(browse.filters ?? []),
    });
    setSaving(true);
    try {
      await discovery.save(next, discovery.config);
      close();
    } catch (error) {
      setError({ code: 'save_failed', cause: error });
    } finally {
      setSaving(false);
    }
  };
  const disabled = saving || !target || !browse || !source.activeSourceId;
  return { target, setTarget, title, setTitle, saving, error, browse, disabled, submit, tabs: discovery.config.tabs };
}
export type SaveDiscoveryListModel = ReturnType<typeof useSaveDiscoveryListModel>;
