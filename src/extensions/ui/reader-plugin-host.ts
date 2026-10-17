import type { BrowserUiManifest } from '@boaa/extension-contracts/ui-package';
import type { UiContext, UiSurfaceAction } from '../../../packages/extension-contracts/ui-lifecycle';
import type { ReaderAddonTabDescriptor } from '../../features/reader/reader-addon-contract';
import { UiPluginStore } from './plugin-store';
import { UiPluginRuntime } from './runtime';
import type { RuntimeInstance } from './runtime-instance';
import type { ReaderContext, SelectionCapture } from './runtime-commands';
import { requireRuntime, requireEnvironment } from './runtime-policy';
export interface ReaderPluginEntry {
  pluginId: string;
  revision: number;
  panelId: string;
  tab: ReaderAddonTabDescriptor;
  commands: NonNullable<BrowserUiManifest['extension']['contributes']['commands']>;
}
interface ShareRequest {
  entry: ReaderPluginEntry;
  commandId: string;
  capture: SelectionCapture;
}
export interface PanelLease {
  ready: Promise<RuntimeInstance>;
  close: () => Promise<void>;
}
export interface ReaderPluginSnapshot {
  entries: readonly ReaderPluginEntry[];
  reader: ReaderContext | null;
  shareSequence: number;
}
/** One host per authenticated tab scope. No globals and no automatically inferred account identity. */
export class ReaderPluginHost {
  private runtime: UiPluginRuntime;
  private snapshot: ReaderPluginSnapshot = { entries: [], reader: null, shareSequence: 0 };
  private listeners = new Set<() => void>();
  private active?: PanelLease;
  private tail: Promise<void> = Promise.resolve();
  private desired: string | null = null;
  private pending?: ShareRequest;
  private closed = false;
  private refreshId = 0;
  private closing?: Promise<void>;
  constructor(
    readonly store: UiPluginStore,
    options: { window: Window; shellUrl: string; deployment: 'self-host' | 'static' | 'native' },
  ) {
    requireEnvironment(options.window, options.deployment);
    this.runtime = new UiPluginRuntime(store, { ...options, reader: () => this.snapshot.reader });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(next: ReaderPluginSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  async refresh(): Promise<void> {
    const request = ++this.refreshId;
    const entries: ReaderPluginEntry[] = [];
    for (const row of await this.store.list()) {
      if (this.closed || request !== this.refreshId) return;
      if (!row.enabled || row.tombstone || !row.manifest) continue;
      let session;
      try {
        session = await this.store.openSession(row.pluginId, row.revision);
        await this.store.assertSession(session);
        let commands = row.manifest.extension.contributes.commands ?? [];
        try {
          await this.store.assertSession(session, 'commands.register');
          await this.store.assertSession(session, 'reader.selection.consume');
        } catch {
          commands = [];
        }
        const tab = row.manifest.extension.contributes.readerAddonTabs[0];
        entries.push({
          pluginId: row.pluginId,
          revision: row.revision,
          panelId: tab.id,
          tab: { id: `sandbox.${row.pluginId}`, label: tab.title, icon: 'file-text', order: tab.order },
          commands,
        });
      } catch {
        /* Disabled, removed or changed since the inventory read; it cannot execute. */
      } finally {
        if (session) this.store.closeSession(session);
      }
    }
    if (this.closed || request !== this.refreshId) return;
    if (JSON.stringify(entries) === JSON.stringify(this.snapshot.entries)) return;
    const previous = this.snapshot.entries.find((entry) => entry.tab.id === this.desired);
    const next = entries.find((entry) => entry.tab.id === this.desired);
    if (previous && previous.revision !== next?.revision) {
      this.pending = undefined;
      void this.active?.close().catch(() => {});
    }
    // Keep active panel/queued command identity when a different installation changes.
    const stableEntries = entries.map((entry) => {
      const prior = this.snapshot.entries.find((item) => item.pluginId === entry.pluginId);
      return prior && JSON.stringify(prior) === JSON.stringify(entry) ? prior : entry;
    });
    this.publish({ ...this.snapshot, entries: stableEntries });
  }
  enterReader(bookId: string, documentRevision: string): () => void {
    if (this.closed) return () => {};
    this.pending = undefined;
    void this.active?.close().catch(() => {});
    const reader = { key: crypto.randomUUID(), bookId, documentRevision };
    this.publish({ ...this.snapshot, reader });
    return () => {
      if (this.snapshot.reader !== reader) return;
      this.pending = undefined;
      this.publish({ ...this.snapshot, reader: null });
      void this.active?.close().catch(() => {});
    };
  }
  selectPanel(tab: string | null): void {
    if (tab === this.desired) return;
    this.desired = tab;
    if (this.pending?.entry.tab.id !== tab) this.pending = undefined;
    void this.active?.close().catch(() => {});
  }
  share(entry: ReaderPluginEntry, commandId: string, capture: SelectionCapture): void {
    requireRuntime(
      !this.closed && this.snapshot.entries.includes(entry) && entry.commands.some((c) => c.id === commandId),
      'PACKAGE_GENERATION_CHANGED',
    );
    requireRuntime(capture.contextKey === this.snapshot.reader?.key, 'CONTEXT_STALE');
    this.pending = { entry, commandId, capture: structuredClone(capture) };
    this.publish({ ...this.snapshot, shareSequence: this.snapshot.shareSequence + 1 });
  }
  mount(
    entry: ReaderPluginEntry,
    container: HTMLElement,
    context: UiContext,
    onSurface: (action: UiSurfaceAction) => void,
  ): PanelLease {
    void this.active?.close().catch(() => {});
    const abort = new AbortController();
    const readerKey = this.snapshot.reader?.key;
    let instance: RuntimeInstance | undefined, closing: Promise<void> | undefined;
    const ready = this.tail.then(async () => {
      requireRuntime(
        !this.closed &&
          !abort.signal.aborted &&
          !!readerKey &&
          this.snapshot.reader?.key === readerKey &&
          this.desired === entry.tab.id,
        'CONTEXT_STALE',
      );
      instance = await this.runtime.start(entry.pluginId, container, context, {
        signal: abort.signal,
        expectedRevision: entry.revision,
        onSurface,
      });
      requireRuntime(!abort.signal.aborted && this.snapshot.reader?.key === readerKey, 'CONTEXT_STALE');
      return instance;
    });
    void ready.catch(() => {});
    const lease: PanelLease = {
      ready,
      close: () => {
        if (closing) return closing;
        abort.abort();
        if (this.active === lease) this.active = undefined;
        closing = (async () => {
          await ready.catch(() => {});
          await instance?.stop();
        })();
        this.tail = closing.catch(() => {});
        return closing;
      },
    };
    this.active = lease;
    return lease;
  }
  async invokePending(lease: PanelLease, entry: ReaderPluginEntry, instance: RuntimeInstance): Promise<void> {
    const request = this.pending;
    if (this.active !== lease || request?.entry !== entry || this.closed) return;
    this.pending = undefined;
    await instance.invoke(request.commandId, request.capture);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pending = undefined;
    this.refreshId++;
    this.publish({ entries: [], reader: null, shareSequence: 0 });
    const stop = this.active?.close();
    this.closing = (async () => {
      try {
        await stop;
        await this.tail;
      } finally {
        try {
          await this.runtime.dispose();
        } finally {
          await this.store.close();
        }
      }
    })();
    return this.closing;
  }
}
