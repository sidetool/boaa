import { readBrandStorage, removeBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import type { Installation } from './store-model';
import { uiKeys, uiRecord } from '@boaa/extension-contracts/ui-json';
import { requireStore } from '../ui/store-model';
export interface ReaderBinding {
  pluginId: string;
  installationId: string;
  revision: number;
  digest: string;
  command: string;
  edge: 'left' | 'right' | 'keyboard';
}
/** Host preference only. A guest cannot create a binding by requesting a permission. */
export class ReaderBindings {
  private value?: ReaderBinding;
  private listeners = new Set<() => void>();
  constructor(private readonly persistence?: { storage: Storage; key: string; window: Window }) {
    this.read();
    persistence?.window.addEventListener('storage', this.changed);
  }
  private read() {
    this.value = undefined;
    try {
      const v: unknown = JSON.parse(
        (this.persistence ? readBrandStorage(this.persistence.storage, this.persistence.key) : null) ?? 'null',
      );
      if (
        uiRecord(v) &&
        uiKeys(v, ['pluginId', 'installationId', 'revision', 'digest', 'command', 'edge']) &&
        ['pluginId', 'installationId', 'digest', 'command'].every(
          (k) => typeof v[k] === 'string' && v[k].length <= 256,
        ) &&
        Number.isSafeInteger(v.revision) &&
        (v.revision as number) > 0 &&
        ['left', 'right', 'keyboard'].includes(String(v.edge))
      )
        this.value = v as unknown as ReaderBinding;
    } catch {
      /* Invalid storage never enables an input binding. */
    }
  }
  private changed = (event: StorageEvent) => {
    if (event.key !== null && event.key !== this.persistence?.key) return;
    this.read();
    this.listeners.forEach((fn) => fn());
  };
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  select(row: Installation, command: string, edge: ReaderBinding['edge']) {
    requireStore(
      row.enabled &&
        !row.tombstone &&
        row.active &&
        row.manifest?.entries.controller?.permissions.includes('reader.input') &&
        row.manifest.contributes.commands.includes(command),
      'INPUT_UNAVAILABLE',
    );
    this.set({
      pluginId: row.pluginId,
      installationId: row.installationId,
      revision: row.revision,
      digest: row.active,
      command,
      edge,
    });
  }
  clear() {
    this.set(undefined);
  }
  private set(value: ReaderBinding | undefined) {
    if (this.persistence) {
      if (value) writeBrandStorage(this.persistence.storage, this.persistence.key, JSON.stringify(value));
      else removeBrandStorage(this.persistence.storage, this.persistence.key);
    }
    this.value = value;
    this.listeners.forEach((fn) => fn());
  }
  close() {
    this.persistence?.window.removeEventListener('storage', this.changed);
    this.listeners.clear();
  }
}
export function matchesReaderBinding(row: Installation, binding: ReaderBinding) {
  return (
    row.enabled &&
    !row.tombstone &&
    row.pluginId === binding.pluginId &&
    row.installationId === binding.installationId &&
    row.revision === binding.revision &&
    row.active === binding.digest
  );
}
