import type { UiSurfaceAction } from '../../../packages/extension-contracts/ui-lifecycle';
import type { UiContext } from '../../../packages/extension-contracts/ui-lifecycle';
import { UiPluginStore, type UiPluginSession } from './plugin-store';
import { RuntimeInstance } from './runtime-instance';
import type { ReaderContext } from './runtime-commands';
import { RUNTIME_LIMITS, requireEnvironment, requireRuntime } from './runtime-policy';
interface RuntimeSlot {
  abort: AbortController;
  instance?: RuntimeInstance;
  settled: Promise<void>;
  finish: () => void;
  detach: () => void;
  finished: boolean;
  released: boolean;
}
export class UiPluginRuntime {
  private instances = new Map<string, RuntimeSlot>();
  private closed = false;
  private readonly tabId = crypto.randomUUID();
  constructor(
    private readonly store: UiPluginStore,
    private readonly options: {
      window: Window;
      shellUrl: string;
      deployment: 'self-host' | 'static' | 'native';
      reader: () => ReaderContext | null;
    },
  ) {}
  /** The signal owns the whole panel lifetime, including preparation before an iframe exists. */
  async start(
    id: string,
    container: HTMLElement,
    context: UiContext,
    options: { signal?: AbortSignal; expectedRevision?: number; onSurface?: (action: UiSurfaceAction) => void } = {},
  ): Promise<RuntimeInstance> {
    requireEnvironment(this.options.window, this.options.deployment);
    requireRuntime(
      !this.closed && !this.instances.has(id) && this.instances.size < RUNTIME_LIMITS.instances,
      'CAPABILITY_UNAVAILABLE',
    );
    const url = new URL(this.options.shellUrl, this.options.window.location.href);
    requireRuntime(
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'INVALID_ARGUMENT',
    );
    requireRuntime(
      container.ownerDocument === this.options.window.document && container.isConnected,
      'INVALID_ARGUMENT',
    );
    requireRuntime(!options.signal?.aborted, 'CANCELLED');
    context = structuredClone(context);
    let finish!: () => void;
    const slot: RuntimeSlot = {
      abort: new AbortController(),
      settled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
      detach: () => {},
      finished: false,
      released: false,
    };
    this.instances.set(id, slot);
    let session: UiPluginSession | undefined, instance: RuntimeInstance | undefined;
    const release = () => {
      slot.detach();
      slot.released = true;
      if (slot.finished && this.instances.get(id) === slot) this.instances.delete(id);
    };
    const abort = () => slot.abort.abort();
    const cancel = () => {
      if (instance) void instance.stop().catch(() => {});
      else if (session) this.store.closeSession(session);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    slot.abort.signal.addEventListener('abort', cancel, { once: true });
    slot.detach = () => {
      options.signal?.removeEventListener('abort', abort);
      slot.abort.signal.removeEventListener('abort', cancel);
    };
    const checkpoint = () => {
      requireRuntime(!slot.abort.signal.aborted, 'CANCELLED');
      requireRuntime(!this.closed, 'PLUGIN_STOPPED');
      requireRuntime(container.isConnected, 'CANCELLED');
    };
    try {
      requireRuntime(!(await this.store.unfinishedMarkers()).some((m) => m.pluginId === id), 'CONTEXT_STALE');
      checkpoint();
      session = await this.store.openSession(id, options.expectedRevision);
      checkpoint();
      const pkg = await this.store.loadSessionPackage(session);
      checkpoint();
      for (const feature of pkg.manifest.requires.features) {
        await this.store.assertSession(session, feature === 'ui.readerAddonTabs' ? 'ui.panel.render' : feature);
        checkpoint();
      }
      instance = new RuntimeInstance(
        this.store,
        session,
        pkg,
        this.options.window,
        release,
        this.options.reader,
        options.onSurface,
      );
      slot.instance = instance;
      await instance.mount(container, url.href, structuredClone(context), this.tabId);
      checkpoint();
      return instance;
    } catch (error) {
      if (instance)
        await instance.stop(slot.abort.signal.aborted || this.closed || !container.isConnected).catch(() => {});
      else if (session) this.store.closeSession(session);
      release();
      throw error;
    } finally {
      slot.finished = true;
      if (slot.released && this.instances.get(id) === slot) this.instances.delete(id);
      slot.finish();
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const slots = [...this.instances.values()];
    for (const slot of slots) slot.abort.abort();
    // Wait for pending archive/IDB preparation too, before the owner closes its store.
    const results = await Promise.allSettled(
      slots.map(async (slot) => {
        await slot.settled;
        await slot.instance?.stop();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
