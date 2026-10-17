import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import type { ConfigRow, Installation } from './store-model';
import type { ProductPluginSession } from './product-session';
import { matchesReaderBinding } from './reader-binding';
import { pluginSettingsFailure, type PluginSettingsFailure } from './plugin-settings-failure';

export function usePluginJsonFieldModel(value: UiJson, change: (value: UiJson) => void) {
  const [text, setText] = useState(JSON.stringify(value));
  const [valid, setValid] = useState(true);
  const changeText = (next: string) => {
    setText(next);
    try {
      change(JSON.parse(next) as UiJson);
      setValid(true);
      return true;
    } catch {
      setValid(false);
      return false;
    }
  };
  return { text, valid, changeText };
}
export type PluginJsonFieldModel = ReturnType<typeof usePluginJsonFieldModel>;

export function usePluginConfigEditorModel(
  session: ProductPluginSession,
  row: Installation,
  config: ConfigRow,
  saved: () => void,
) {
  const [value, setValue] = useState(config.value);
  const [error, setError] = useState<PluginSettingsFailure>();
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    setError(undefined);
    return session.store
      .writeHostConfig(row.pluginId, row.revision, {
        schema: config.schema,
        expectedRevision: config.revision,
        value,
      })
      .then(saved)
      .catch((cause) => setError(pluginSettingsFailure(cause)))
      .finally(() => setBusy(false));
  };
  return { value, setValue, error, busy, save, fields: config.schema.fields };
}
export type PluginConfigEditorModel = ReturnType<typeof usePluginConfigEditorModel>;

export function usePluginViewModel(session: ProductPluginSession, id: string, view: string) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<PluginSettingsFailure>();
  useEffect(() => {
    const abort = new AbortController();
    void session.views.open(id, view, container.current!, abort.signal).catch((cause) => {
      if (!abort.signal.aborted) setError(pluginSettingsFailure(cause));
    });
    return () => abort.abort();
  }, [session, id, view]);
  return { container, error };
}
export type PluginViewModel = ReturnType<typeof usePluginViewModel>;

export function usePluginReaderInputModel(session: ProductPluginSession, row: Installation) {
  const binding = useSyncExternalStore(session.bindings.subscribe, session.bindings.get);
  const selected = binding && matchesReaderBinding(row, binding) ? binding : undefined;
  const [error, setError] = useState<PluginSettingsFailure>();
  const available = Boolean(
    row.enabled && !session.off && row.manifest?.entries.controller?.permissions.includes('reader.input'),
  );
  const selectCommand = (command: string) => {
    try {
      if (command) session.bindings.select(row, command, selected?.edge ?? 'right');
      else session.bindings.clear();
      setError(undefined);
    } catch (cause) {
      setError(pluginSettingsFailure(cause));
    }
  };
  const selectEdge = (edge: 'left' | 'right' | 'keyboard') => {
    if (!selected) return;
    try {
      session.bindings.select(row, selected.command, edge);
      setError(undefined);
    } catch (cause) {
      setError(pluginSettingsFailure(cause));
    }
  };
  return {
    selected,
    error,
    available,
    selectCommand,
    selectEdge,
    commands: row.manifest?.contributes.commands ?? [],
    edges: ['right', 'left', 'keyboard'] as const,
  };
}
export type PluginReaderInputModel = ReturnType<typeof usePluginReaderInputModel>;
