import type { UI_ERROR_CODES } from '@boaa/extension-contracts/ui-protocol';
import type { UiContext } from '../../../packages/extension-contracts/ui-lifecycle';
import {
  validHello,
  validSurface,
  type UiSurfaceAction,
  validBound,
  validLifecycle,
  validContext,
} from '../../../packages/extension-contracts/ui-lifecycle';
import type { VerifiedBrowserUiPackage } from '../packages/browser-ui-package';
import { UiPluginStore, type UiPluginSession } from './plugin-store';
import { RuntimeDispatcher } from './runtime-dispatcher';
import type { ReaderContext, SelectionCapture } from './runtime-commands';
import { RUNTIME_LIMITS, UiRuntimeError, requireRuntime } from './runtime-policy';
export class RuntimeInstance {
  readonly instanceId = crypto.randomUUID();
  private phase: 'booting' | 'activating' | 'ready' | 'stopping' | 'stopped' = 'booting';
  private frame?: HTMLIFrameElement;
  private port?: MessagePort;
  private dispatcher: RuntimeDispatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: ReturnType<typeof setInterval>;
  private pollingBusy = false;
  private cleanup?: Promise<void>;
  private sequence = 0;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private hello?: (event: MessageEvent) => void;
  private stoppedAck?: () => void;
  constructor(
    private readonly store: UiPluginStore,
    private readonly session: UiPluginSession,
    private readonly pkg: VerifiedBrowserUiPackage,
    private readonly win: Window,
    private readonly released: () => void,
    reader: () => ReaderContext | null,
    private readonly onSurface?: (action: UiSurfaceAction) => void,
  ) {
    void this.ready.catch(() => {});
    this.dispatcher = new RuntimeDispatcher(
      store,
      session,
      this.instanceId,
      pkg.manifest,
      () => this.phase,
      (v) => this.send(v),
      (code) => {
        void this.stop(false, code);
      },
      reader,
    );
  }
  private failureCode?: (typeof UI_ERROR_CODES)[number];
  get failure(): string | undefined {
    return this.failureCode;
  }
  get state(): string {
    return this.phase;
  }
  private send(message: unknown): void {
    if (this.phase === 'stopped') return;
    try {
      this.port?.postMessage(message);
    } catch {
      if (this.phase !== 'stopping') void this.stop(false);
    }
  }
  async mount(container: HTMLElement, shellUrl: string, context: UiContext, tabId: string): Promise<void> {
    requireRuntime(
      validContext(context) && context.panelId === this.pkg.manifest.extension.contributes.readerAddonTabs[0].id,
      'INVALID_ARGUMENT',
    );
    await this.store.startMarker(this.session, tabId, this.instanceId);
    requireRuntime(this.phase === 'booting' && container.isConnected, 'PLUGIN_STOPPED');
    const frame = this.win.document.createElement('iframe');
    this.frame = frame;
    frame.tabIndex = 0;
    frame.title = this.pkg.manifest.extension.name;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute(
      'allow',
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
    );
    let loads = 0,
      bound = false,
      delivered = false,
      readySeen = false;
    const fail = () => {
      void this.stop(false);
    };
    frame.addEventListener('load', () => {
      if (++loads > 1) fail();
    });
    frame.addEventListener('error', fail);
    this.hello = (event) => {
      if (event.source !== frame.contentWindow) return;
      if (!validHello(event.data) || event.origin !== 'null' || bound || this.phase !== 'booting') {
        fail();
        return;
      }
      bound = true;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessageerror = fail;
      this.port.onmessage = (message) => {
        if (this.phase === 'stopping') {
          if (validLifecycle(message.data, this.instanceId) && message.data.state === 'stopped') this.stoppedAck?.();
          return;
        }
        if (this.phase === 'stopped') return;
        if (!delivered) {
          if (!validBound(message.data, this.instanceId)) {
            fail();
            return;
          }
          delivered = true;
          void this.store
            .assertSession(this.session)
            .then(() => {
              if (this.phase !== 'booting') return;
              this.phase = 'activating';
              this.send({ kind: 'code', wireVersion: 1, sessionId: this.instanceId, source: this.pkg.source, context });
            })
            .catch(fail);
          return;
        }
        if (validLifecycle(message.data, this.instanceId)) {
          if (message.data.state !== 'ready' || this.phase !== 'activating' || readySeen) {
            fail();
            return;
          }
          readySeen = true;
          // Final approval check also covers revocation during activate().
          void this.store
            .assertSession(this.session)
            .then(() => {
              if (this.phase !== 'activating') return;
              this.phase = 'ready';
              clearTimeout(this.timer);
              this.resolveReady();
            })
            .catch(fail);
          return;
        }
        if (validSurface(message.data, this.instanceId)) {
          if (!this.dispatcher.acceptControl()) return;
          if (this.phase === 'ready' && this.win.document.activeElement === frame) {
            this.onSurface?.(message.data.action);
          }
          return;
        }
        this.dispatcher.receive(message.data);
      };
      this.port.start();
      // Opaque child cannot be targeted by an origin. This is the only wildcard send.
      frame.contentWindow!.postMessage(
        { kind: 'bind', wireVersion: 1, nonce: event.data.nonce, sessionId: this.instanceId },
        '*',
        [channel.port2],
      );
    };
    this.win.addEventListener('message', this.hello);
    this.timer = setTimeout(() => {
      void this.stop(false, 'TIMEOUT');
    }, RUNTIME_LIMITS.startupMs);
    this.polling = setInterval(() => {
      if (this.pollingBusy || this.phase === 'stopping' || this.phase === 'stopped') return;
      this.pollingBusy = true;
      void this.store
        .assertSession(this.session)
        .catch(fail)
        .finally(() => {
          this.pollingBusy = false;
        });
    }, 1000);
    frame.src = shellUrl;
    container.append(frame);
    return this.ready;
  }
  async invoke(commandId: string, capture?: SelectionCapture): Promise<void> {
    await this.ready;
    return this.dispatcher.commands.invoke(commandId, capture);
  }
  readerChanged(): void {
    this.dispatcher.commands.contextChanged();
  }
  async updateContext(context: UiContext): Promise<void> {
    context = structuredClone(context);
    requireRuntime(
      validContext(context) && context.panelId === this.pkg.manifest.extension.contributes.readerAddonTabs[0].id,
      'INVALID_ARGUMENT',
    );
    await this.store.assertSession(this.session);
    requireRuntime(this.phase === 'ready', 'PLUGIN_STOPPED');
    this.send({
      wireVersion: 1,
      kind: 'event',
      sessionId: this.instanceId,
      eventId: crypto.randomUUID(),
      sequence: ++this.sequence,
      event: 'ui.contextChanged',
      payload: structuredClone(context),
    });
  }
  /** Revoke first; cleanup success is never required to stop guest access. Faults retain the marker. */
  stop(normal = true, reason: (typeof UI_ERROR_CODES)[number] = 'PLUGIN_STOPPED'): Promise<void> {
    if (this.cleanup) return this.cleanup;
    if (!normal) this.failureCode = reason;
    this.phase = 'stopping';
    clearTimeout(this.timer);
    clearInterval(this.polling);
    this.dispatcher.close();
    this.rejectReady(new UiRuntimeError(reason));
    if (this.hello) this.win.removeEventListener('message', this.hello);
    let markerFailure: unknown;
    let clearMarker = () => Promise.resolve();
    try {
      if (normal) clearMarker = this.store.retireSession(this.session, this.instanceId);
      else this.store.closeSession(this.session);
    } catch (error) {
      markerFailure = error;
      this.store.closeSession(this.session);
    }
    this.cleanup = (async () => {
      if (this.port)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RUNTIME_LIMITS.shutdownMs);
          this.stoppedAck = () => {
            clearTimeout(timer);
            resolve();
          };
          this.send({ wireVersion: 1, kind: 'lifecycle', sessionId: this.instanceId, state: 'stop' });
        });
      this.port?.close();
      this.frame?.remove();
      this.phase = 'stopped';
      try {
        await clearMarker();
        if (markerFailure) throw markerFailure;
      } finally {
        this.released();
      }
    })();
    // Internal fault paths are fire-and-forget; explicit host stop still receives cleanup failures.
    void this.cleanup.catch(() => {});
    return this.cleanup;
  }
}
