import { useState } from 'react';
import { randomUuid } from '../../utils/random-uuid';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import { move, type DiscoveryConfig, type DiscoveryTab } from './discovery-config';
export type DiscoveryEditorError = { code: 'invalid_tabs' } | { code: 'save_failed'; cause: unknown };
export interface DiscoveryEditorModelOptions {
  config: DiscoveryConfig;
  sources: readonly ExternalSourceView[];
  save(value: DiscoveryConfig, base: DiscoveryConfig): void | Promise<void>;
  close(): void;
}
export function useDiscoveryEditorModel({ config, sources, save, close }: DiscoveryEditorModelOptions) {
  const [base] = useState(config);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<DiscoveryConfig>(() => structuredClone(config));
  const [expandedTab, setExpandedTab] = useState<string | undefined>(config.tabs[0]?.id);
  const [expandedSection, setExpandedSection] = useState<string>();
  const [focusNewTab, setFocusNewTab] = useState<string>();
  const [error, setError] = useState<DiscoveryEditorError>();
  const [undo, setUndo] = useState<DiscoveryConfig>();
  const update = (fn: (draft: DiscoveryConfig) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      fn(next);
      return next;
    });
  const submit = async () => {
    if (!draft.tabs.some((t) => !t.hidden) || draft.tabs.some((t) => !t.title.trim())) {
      setExpandedTab(draft.tabs.find((t) => !t.title.trim())?.id ?? draft.tabs[0]?.id);
      setError({ code: 'invalid_tabs' });
      return;
    }
    setSaving(true);
    try {
      await save(draft, base);
      close();
    } catch (error) {
      setError({ code: 'save_failed', cause: error });
    } finally {
      setSaving(false);
    }
  };
  const addTab = (tab: DiscoveryTab) => {
    update((d) => {
      d.tabs.push(tab);
    });
    setExpandedTab(tab.id);
    setFocusNewTab(tab.id);
  };
  const applyTemplate = (templates: DiscoveryTab[]) => {
    setUndo(structuredClone(draft));
    const connected = sources.filter((s) => s.kind === 'catalog' && s.connection.state === 'connected');
    templates[0]!.sections = connected
      .filter((s) => s.contentKind !== 'text')
      .slice(0, 4)
      .map((s) => ({ id: randomUuid(), sourceId: s.id, mode: 'popular', title: '' }));
    templates[1]!.sections = connected
      .filter((s) => s.contentKind === 'text')
      .slice(0, 4)
      .map((s) => ({ id: randomUuid(), sourceId: s.id, mode: 'popular', title: '' }));
    setDraft({ version: 1, tabs: templates });
    setExpandedTab(templates[0]!.id);
  };
  const restore = () => {
    if (!undo) return;
    setDraft(undo);
    setExpandedTab(undo.tabs[0]?.id);
    setUndo(undefined);
  };
  const moveTab = (index: number, offset: number) =>
    update((d) => {
      d.tabs = move(d.tabs, index, offset);
    });
  const dropTab = (id: string, index: number) => {
    const from = draft.tabs.findIndex((t) => t.id === id);
    if (from >= 0) moveTab(from, index - from);
  };
  const renameTab = (index: number, title: string) =>
    update((d) => {
      d.tabs[index]!.title = title;
    });
  const removeTab = (index: number) => {
    setUndo(structuredClone(draft));
    update((d) => {
      d.tabs.splice(index, 1);
    });
  };
  const showTab = (index: number, visible: boolean) =>
    update((d) => {
      d.tabs[index]!.hidden = !visible;
    });
  const moveSection = (index: number, sectionIndex: number, offset: number) =>
    update((d) => {
      d.tabs[index]!.sections = move(d.tabs[index]!.sections, sectionIndex, offset);
    });
  const dropSection = (index: number, id: string, sectionIndex: number) => {
    const from = draft.tabs[index]!.sections.findIndex((row) => row.id === id);
    if (from >= 0) moveSection(index, from, sectionIndex - from);
  };
  const setSectionSource = (index: number, sectionIndex: number, sourceId: string) =>
    update((d) => {
      const row = d.tabs[index]!.sections[sectionIndex]!;
      row.sourceId = sourceId;
      delete row.filters;
      delete row.filterSignature;
      delete row.parentRef;
    });
  const setSectionMode = (index: number, sectionIndex: number, mode: 'popular' | 'latest') =>
    update((d) => {
      d.tabs[index]!.sections[sectionIndex]!.mode = mode;
    });
  const setSectionTitle = (index: number, sectionIndex: number, title: string) =>
    update((d) => {
      d.tabs[index]!.sections[sectionIndex]!.title = title;
    });
  const removeSection = (index: number, sectionIndex: number) => {
    setUndo(structuredClone(draft));
    update((d) => {
      d.tabs[index]!.sections.splice(sectionIndex, 1);
    });
  };
  const addSection = (index: number) => {
    const source = sources.find((s) => s.connection.state === 'connected' && s.kind === 'catalog') ?? sources[0];
    if (!source) return;
    const id = randomUuid();
    setExpandedSection(id);
    update((d) => {
      d.tabs[index]!.sections.push({ id, sourceId: source.id, mode: 'popular', title: '' });
    });
    return id;
  };
  return {
    draft,
    saving,
    expandedTab,
    setExpandedTab,
    expandedSection,
    setExpandedSection,
    focusNewTab,
    setFocusNewTab,
    error,
    undo,
    submit,
    addTab,
    applyTemplate,
    restore,
    moveTab,
    dropTab,
    renameTab,
    removeTab,
    showTab,
    moveSection,
    dropSection,
    setSectionSource,
    setSectionMode,
    setSectionTitle,
    removeSection,
    addSection,
  };
}
export type DiscoveryEditorModel = ReturnType<typeof useDiscoveryEditorModel>;
