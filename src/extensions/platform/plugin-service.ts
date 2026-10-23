import type { PluginHttp } from './plugin-http';
import { OrderedDecoration } from './ordered-decoration';
import { PluginReaderSession, type PluginReaderAdapter } from './reader-session';
import { ReaderBindings, matchesReaderBinding, type ReaderBinding } from './reader-binding';
import { ReaderDecorationRuntime, type DecorationPlan, type PluginReaderContent } from './reader-decoration-runtime';
import type { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
import { PluginTaskRuntime, taskResources } from './task-runtime';
import { RuntimeOwners } from './runtime-owners';
import { isUiJson, uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore, UiStoreError } from '../ui/store-model';
import { PlatformPluginStore } from './plugin-store';
import { ControllerVm, controllerResources, type ControllerOptions } from './controller-vm';
import type { Installation, PluginSession, ConfigRow } from './store-model';
import { validateSettingsSchema } from './settings-schema';
import { storageCall } from './storage-call';
import { PluginHomeRuntime } from './home-runtime';
import { sleepControllerJob } from './controller-jobs';
const retired = (error: unknown) =>
  error instanceof UiStoreError && ['PACKAGE_GENERATION_CHANGED', 'CONTEXT_STALE'].includes(error.code);
interface Running {
  row: Installation;
  ready: Promise<void>;
  session?: PluginSession;
  vm?: ControllerVm;
  activation?: Promise<void>;
  active: boolean;
  stopped: boolean;
  configRevision: number;
  views: number;
  homeCalls: number;
  paintVersion: number;
  paintPlan?: DecorationPlan;
  ordered: string[];
  orderedCache: OrderedDecoration;
  paintChanges: number[];
}
const publicConfig = (row?: ConfigRow): UiJson =>
  row ? { schemaVersion: row.schema.version, revision: row.revision, value: row.value } : null;
/** Account-scoped controller lifetime, authority and reader coordination. */
export class PluginService {
  private version = 0;
  private installationKey = '';
  private listeners = new Set<() => void>();
  private readonly home: PluginHomeRuntime;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.version;
  readonly bindings: ReaderBindings;
  private actions?: PluginReaderSession;
  private unbind: () => void;
  private records = new Map<string, Running>();
  private homeAdmissions = new Set<AbortController>();
  private faults = new Map<string, { revision: number; code: string }>();
  private closed = false;
  private reader = false;
  private readerGeneration = 0;
  private paint?: ReaderDecorationRuntime;
  private appStarted = false;
  private poll?: ReturnType<typeof setInterval>;
  private reconciliation?: Promise<void>;
  private reconciliationRequested = false;
  private checking = false;
  private owners?: RuntimeOwners;
  private tasks?: PluginTaskRuntime;
  private cleanup = new Set<Promise<void>>();
  private cleanupErrors: string[] = [];
  constructor(
    private readonly store: PlatformPluginStore,
    private readonly options: Pick<ControllerOptions, 'worker' | 'wasmUrl'> & {
      off?: boolean;
      bindings?: ReaderBindings;
      http?: PluginHttp;
    },
  ) {
    this.home = new PluginHomeRuntime(
      { list: () => store.list(), invoke: (row, section, signal) => this.invokeHomeFeed(row, section, signal) },
      options.http,
      options.off,
    );
    this.bindings = options.bindings ?? new ReaderBindings();
    this.unbind = this.bindings.subscribe(() => this.actions?.interrupt());
    if (options.off) return;
    this.owners = new RuntimeOwners();
    this.tasks = new PluginTaskRuntime(store, this.owners, options);
    this.poll = setInterval(() => {
      void this.checkAuthority();
    }, 500);
  }
  status() {
    return {
      running: [...this.records].map(([id, r]) => ({ id, active: r.active, views: r.views, ready: !!r.vm })),
      faults: [...this.faults].map(([id, f]) => ({ id, ...f })),
      cleanupErrors: [...this.cleanupErrors],
      tasks: taskResources(),
      reader: this.paint?.status(),
    };
  }
  private track(promise: Promise<void>) {
    this.cleanup.add(promise);
    void promise
      .catch(() => {
        this.cleanupErrors.push('MARKER_CLEANUP_FAILED');
      })
      .finally(() => this.cleanup.delete(promise));
  }
  private stop(record: Running, reason = 'STOPPED') {
    if (record.stopped) return;
    record.stopped = true;
    if (record.session) this.actions?.revoke(record.session.fence.instanceId);
    this.paint?.invalidate(record.row.pluginId);
    this.records.delete(record.row.pluginId);
    // Revoke before terminating: pending IDB transactions are aborted synchronously.
    let finish: (() => Promise<void>) | undefined;
    if (record.session) {
      try {
        finish = this.store.retireSession(record.session);
      } catch {
        this.store.closeSession(record.session);
      }
    }
    record.paintPlan = undefined;
    record.orderedCache.clear();
    record.vm?.stop(reason);
    if (record.session) this.owners?.remove(record.session.fence.instanceId);
    if (reason === 'STOPPED' && finish) this.track(finish());
    if (reason !== 'STOPPED') this.faults.set(record.row.pluginId, { revision: record.row.revision, code: reason });
  }
  private stopAll(reason = 'STOPPED') {
    for (const record of [...this.records.values()]) this.stop(record, reason);
  }
  private async liveMarkers(id: string): Promise<void> {
    const rows = (await this.store.unfinishedMarkers()).filter((r) => r.pluginId === id);
    if (!rows.length) return;
    requireStore(this.owners, 'RECOVERY_REQUIRED');
    await this.owners.assertLive(rows.map((r) => r.instanceId));
  }

  private async currentRow(id: string): Promise<Installation> {
    requireStore(!this.closed, 'SERVICE_CLOSED');
    const row = (await this.store.list()).find((r) => r.pluginId === id && !r.tombstone);
    requireStore(row, 'PACKAGE_UNAVAILABLE');
    return row;
  }
  private ensure(row: Installation): Running {
    const existing = this.records.get(row.pluginId);
    // A controller waiting for storage/session setup already owns its future slot.
    const workers = () =>
      controllerResources('controller').workers + [...this.records.values()].filter((record) => !record.vm).length;
    // Release unused, completed controllers before admitting another plugin.
    if (!existing && workers() >= 4)
      for (const record of [...this.records.values()]) {
        if (
          record.vm?.idle &&
          record.homeCalls === 0 &&
          record.views === 0 &&
          !record.row.manifest?.activation.includes('onAppSession') &&
          (!this.reader || !record.row.manifest?.activation.includes('onReader'))
        )
          this.stop(record);
        if (workers() < 4) break;
      }
    requireStore(!this.options.off, 'PLUGINS_DISABLED');
    requireStore(!this.closed && row.enabled && row.manifest?.entries.controller, 'CONTROLLER_UNAVAILABLE');
    const previous = this.records.get(row.pluginId);
    if (previous?.row.revision === row.revision) return previous;
    if (previous) this.stop(previous);
    requireStore(this.faults.get(row.pluginId)?.revision !== row.revision, 'RECOVERY_REQUIRED');
    requireStore(workers() < 4, 'WORKER_LIMIT');
    this.faults.delete(row.pluginId);
    const record: Running = {
      row,
      ready: Promise.resolve(),
      active: false,
      stopped: false,
      configRevision: 0,
      views: 0,
      homeCalls: 0,
      paintVersion: 0,
      ordered: [],
      orderedCache: new OrderedDecoration(),
      paintChanges: [],
    };
    this.records.set(row.pluginId, record);
    record.ready = this.start(record).catch((error) => {
      if (retired(error) || (error instanceof Error && error.message === 'WORKER_LIMIT')) {
        this.stop(record);
        throw error;
      }
      this.stop(
        record,
        error instanceof Error && error.message === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'START_FAILED',
      );
      throw error;
    });
    void record.ready.catch(() => {});
    return record;
  }
  private guard(record: Running) {
    requireStore(!this.closed && !record.stopped && this.records.get(record.row.pluginId) === record, 'CONTEXT_STALE');
  }
  private async start(record: Running) {
    await this.liveMarkers(record.row.pluginId);
    this.guard(record);
    const session = await this.store.openSession(record.row.pluginId, 'controller', record.row.revision);
    if (record.stopped || this.closed) {
      this.store.closeSession(session);
      throw Error('CONTEXT_STALE');
    }
    record.session = session;
    const source = await this.store.loadEntry(session);
    this.guard(record);
    await this.store.startMarker(session);
    this.owners?.add(session.fence.instanceId);
    this.guard(record);
    const permissions = await this.store.sessionPermissions(session);
    this.guard(record);
    record.vm = new ControllerVm(session, source, {
      ...this.options,
      broker: (method, input, signal) => this.broker(record, method, input, signal),
      onStop: (reason) => this.stop(record, reason),
    });
    const descriptor = await record.vm.invoke('describe', {
      commands: record.row.manifest!.contributes.commands,
      decorations: record.row.manifest!.contributes.decorations,
      homeSections: record.row.manifest!.contributes.homeSections?.map((section) => section.id) ?? [],
      permissions,
    });
    this.guard(record);
    if (descriptor !== null) {
      validateSettingsSchema(descriptor);
      const config = await this.store.registerSettings(session, descriptor);
      this.guard(record);
      record.configRevision = config.revision;
    }
  }
  private async broker(record: Running, method: string, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    this.guard(record);
    signal.throwIfAborted();
    const session = record.session!;
    await this.store.assertCall(session, session.fence, method);
    this.guard(record);
    signal.throwIfAborted();
    requireStore(uiRecord(input), 'INVALID_ARGUMENT');
    let value: UiJson;
    if (method.startsWith('storage.')) {
      value = await storageCall(this.store, session, method, input);
    } else if (method === 'http.request' || method === 'http.cancel') {
      requireStore(this.options.http, 'HTTP_UNAVAILABLE');
      value = await this.options.http.controller(session, method, input, signal);
    } else if (
      [
        'reader.state.get',
        'reader.annotations.list',
        'reader.annotations.create',
        'reader.annotations.update',
        'reader.annotations.delete',

        'reader.content.read',
        'reader.content.search',
        'reader.auto.start',
        'reader.auto.update',
        'reader.auto.stop',
      ].includes(method)
    ) {
      const actions = this.actions;
      requireStore(actions, 'READER_UNAVAILABLE');
      value = await actions.call(
        session.fence.instanceId,
        method,
        input,
        signal,
        async () => {
          await this.store.assertCall(session, session.fence, method);
          this.guard(record);
          requireStore(actions === this.actions, 'READER_CONTEXT_STALE');
          if (method === 'reader.annotations.create')
            await this.store.assertCall(session, session.fence, 'reader.content.read');
        },
        JSON.stringify([session.fence.scopeId, session.fence.installationId]),
      );
      requireStore(actions === this.actions, 'READER_CONTEXT_STALE');
    } else if (method === 'reader.decorations.changed') {
      requireStore(uiKeys(input, [], ['ordered']), 'INVALID_ARGUMENT');
      if (input.ordered !== undefined) {
        requireStore(
          Array.isArray(input.ordered) &&
            input.ordered.length <= 8 &&
            input.ordered.every(
              (id) => typeof id === 'string' && record.row.manifest!.contributes.decorations.includes(id),
            ),
          'INVALID_ARGUMENT',
        );
        if (input.ordered.length) await this.store.assertSession(session, session.fence, 'reader.content.book');
      }
      const now = Date.now();
      record.paintChanges = record.paintChanges.filter((time) => time > now - 1000);
      requireStore(record.paintChanges.length < 10, 'DECORATION_RATE_LIMIT');
      this.guard(record);
      signal.throwIfAborted();
      if (input.ordered !== undefined) record.ordered = [...new Set(input.ordered as string[])];
      record.orderedCache.clear();
      record.paintChanges.push(now);
      record.paintVersion++;
      this.paint?.invalidate(record.row.pluginId);
      value = null;
    } else if (method === 'tasks.run') {
      requireStore(uiKeys(input, ['input']) && this.tasks, 'INVALID_ARGUMENT');
      value = await this.tasks.run(session, input.input as UiJson, signal);
    } else if (method === 'jobs.sleep') {
      requireStore(uiKeys(input, ['ms']) && uiInteger(input.ms, 0, 10000), 'INVALID_ARGUMENT');
      await sleepControllerJob(input.ms, signal);
      value = null;
    } else if (method === 'settings.get') {
      requireStore(uiKeys(input, []), 'INVALID_ARGUMENT');
      value = publicConfig(await this.store.readConfig(session));
    } else if (method === 'settings.set') {
      requireStore(
        uiKeys(input, ['expectedRevision', 'value']) &&
          uiInteger(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) &&
          uiRecord(input.value),
        'INVALID_ARGUMENT',
      );
      const old = await this.store.readConfig(session);
      requireStore(old, 'CONFIG_UNAVAILABLE');
      this.guard(record);
      signal.throwIfAborted();
      value = publicConfig(
        await this.store.writeConfig(
          session,
          {
            expectedRevision: input.expectedRevision,
            schema: old.schema,
            value: input.value as Record<string, UiJson>,
          },
          signal,
        ),
      );
    } else throw Error('METHOD_NOT_ALLOWED');
    try {
      await this.store.assertSession(session, session.fence);
      this.guard(record);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      if (!signal.aborted) this.actions?.revoke(session.fence.instanceId);
      throw error;
    }
  }
  private async activate(record: Running): Promise<void> {
    await record.ready;
    this.guard(record);
    if (!record.activation)
      record.activation = (async () => {
        await this.store.assertSession(record.session!, record.session!.fence);
        await record.vm!.invoke('activate');
        this.guard(record);
        record.active = true;
      })();
    await record.activation;
  }
  private async event(record: Running, id: string, value: UiJson = {}) {
    if (!record.active || record.stopped) return;
    await this.store.assertSession(record.session!, record.session!.fence);
    this.guard(record);
    await record.vm!.invoke('event', { id, value });
  }
  private async checkAuthority(): Promise<void> {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      for (const record of [...this.records.values()])
        if (record.session && !record.stopped) {
          try {
            await this.store.assertSession(record.session, record.session.fence);
          } catch {
            this.stop(record);
          }
        }
      void this.reconcile().catch(() => this.stopAll('AUTHORITY_LOST'));
    } finally {
      this.checking = false;
    }
  }
  reconcile(): Promise<void> {
    this.reconciliationRequested = true;
    if (this.reconciliation) return this.reconciliation;
    const next = Promise.resolve().then(async () => {
      if (this.closed) return;
      do {
        this.reconciliationRequested = false;
        const rows = await this.store.list();
        if (this.closed) return;
        const key = JSON.stringify(
          rows.map((row) => [row.pluginId, row.installationId, row.revision, row.enabled, row.active, row.tombstone]),
        );
        if (key !== this.installationKey) {
          this.installationKey = key;
          this.home.reconcile(rows);
          this.version++;
          this.listeners.forEach((listener) => listener());
        }
        const binding = this.bindings.get();
        if (binding && !rows.some((row) => matchesReaderBinding(row, binding))) this.bindings.clear();
        for (const record of [...this.records.values()]) {
          const row = rows.find((r) => r.pluginId === record.row.pluginId);
          if (
            !row ||
            !row.enabled ||
            row.tombstone ||
            row.revision !== record.row.revision ||
            row.installationId !== record.row.installationId ||
            row.active !== record.row.active
          )
            this.stop(record);
        }
        for (const row of rows.filter((r) => r.enabled && !r.tombstone && r.manifest?.entries.controller)) {
          const trigger =
            (this.reader && row.manifest!.activation.includes('onReader')) ||
            (this.appStarted && row.manifest!.activation.includes('onAppSession'));
          if (trigger && this.faults.get(row.pluginId)?.revision !== row.revision) {
            try {
              await this.activate(this.ensure(row));
            } catch {
              /* Fault recorded; do not restart this generation. */
            }
          }
        }
        for (const record of [...this.records.values()])
          if (record.active && !record.stopped) {
            try {
              const permissions = await this.store.sessionPermissions(record.session!);
              if (!permissions.includes('settings.own')) continue;
              const config = await this.store.readConfig(record.session!);
              if (config && config.revision !== record.configRevision) {
                this.paint?.invalidate(record.row.pluginId);
                await this.event(record, 'settings.changed', publicConfig(config));
                record.configRevision = config.revision;
              }
            } catch (error) {
              this.stop(record, retired(error) ? 'STOPPED' : 'AUTHORITY_LOST');
            }
          }
        await this.refreshPaint();
      } while (this.reconciliationRequested && !this.closed);
    });
    this.reconciliation = next;
    void next
      .finally(() => {
        if (this.reconciliation === next) this.reconciliation = undefined;
      })
      .catch(() => {});
    return next;
  }
  /** Actual Reader adapter. Replacing it revokes input and motion before any asynchronous work. */
  connectReaderActions(adapter: PluginReaderAdapter) {
    requireStore(!this.closed, 'SERVICE_CLOSED');
    if (this.options.off) return;
    this.actions?.close();
    const actions = new PluginReaderSession(adapter);
    this.actions = actions;
    return () => {
      actions.close();
      if (this.actions === actions) this.actions = undefined;
    };
  }
  interruptReader() {
    this.actions?.interrupt();
  }
  /** Called only by a trusted input adapter after a user-selected binding crosses its hold threshold. */
  async boundReaderCommand(binding: ReaderBinding, signal: AbortSignal): Promise<void> {
    const actions = this.actions;
    const guard = () =>
      requireStore(
        !signal.aborted && !!actions && this.actions === actions && this.bindings.get() === binding && !this.closed,
        'INPUT_EXPIRED',
      );
    guard();
    const row = await this.currentRow(binding.pluginId);
    guard();
    requireStore(
      matchesReaderBinding(row, binding) && row.manifest?.contributes.commands.includes(binding.command),
      'INPUT_EXPIRED',
    );
    const record = this.ensure(row);
    await record.ready;
    guard();
    if (!record.active) {
      requireStore(row.manifest!.activation.includes('onCommand'), 'NOT_ACTIVE');
      await this.activate(record);
    }
    const session = record.session!;
    await this.store.assertSession(session, session.fence, 'reader.input');
    await this.store.assertSession(session, session.fence, 'commands.register');
    this.guard(record);
    guard();
    const interactionId = actions!.begin(session.fence.instanceId, signal);
    try {
      await record.vm!.invoke(
        'command',
        { id: binding.command, value: { event: 'hold.start', interactionId } },
        signal,
      );
      await this.store.assertSession(session, session.fence, 'reader.input');
      this.guard(record);
      guard();
    } catch (error) {
      actions!.end(interactionId);
      throw error;
    }
  }
  /** Host-only attachment. A later Reader replaces the previous one synchronously. */
  connectReader(layers: ReaderPluginDecorationLayers) {
    requireStore(!this.closed, 'SERVICE_CLOSED');
    if (this.options.off) return;
    this.paint?.close();
    const paint = new ReaderDecorationRuntime(layers);
    this.paint = paint;
    void this.setReader(true).catch(() => paint.update());
    return {
      update: (content?: PluginReaderContent) => {
        if (this.paint === paint) paint.update(content);
      },
      close: () => {
        paint.close();
        if (this.paint === paint) {
          this.paint = undefined;
          void this.setReader(false).catch(() => {});
        }
      },
    };
  }
  private async refreshPaint() {
    const paint = this.paint;
    if (!paint || this.closed) return;
    const plans: DecorationPlan[] = [];
    for (const record of this.records.values()) {
      if (!record.active || record.stopped || !record.row.manifest?.contributes.decorations.length) continue;
      const session = record.session!;
      try {
        await this.store.assertCall(session, session.fence, 'reader.decorations.changed');
        const permissions = await this.store.sessionPermissions(session);
        const config = permissions.includes('settings.own') ? await this.store.readConfig(session) : undefined;
        this.guard(record);
        const version = record.paintVersion;
        const key = JSON.stringify([session.fence, config?.revision ?? 0, version]);
        // Reuse only the derived plan, after all durable authority/config reads above.
        // The key captures the session fence, config revision and registration version.
        if (record.paintPlan?.key === key) {
          plans.push(record.paintPlan);
          continue;
        }
        plans.push(
          (record.paintPlan = {
            id: record.row.pluginId,
            key,
            configRevision: config?.revision ?? 0,
            run: async (content, signal) => {
              const actions = this.actions;
              const ordered = [...record.ordered];
              const authority = async () => {
                this.guard(record);
                signal.throwIfAborted();
                requireStore(record.paintVersion === version, 'REGISTRATION_CHANGED');
                await this.store.assertCall(session, session.fence, 'reader.decorations.changed');
                await this.store.assertSession(session, session.fence, 'reader.content.book');
                if (config)
                  requireStore((await this.store.readConfig(session))?.revision === config.revision, 'CONFIG_CHANGED');
                this.guard(record);
                requireStore(actions && actions === this.actions, 'READER_CONTEXT_STALE');
              };
              const compute = async (blocks: PluginReaderContent['blocks'], checkpoints?: UiJson) => {
                this.guard(record);
                signal.throwIfAborted();
                await this.store.assertCall(session, session.fence, 'reader.decorations.changed');
                this.guard(record);
                signal.throwIfAborted();
                if (checkpoints !== undefined) await authority();
                const input = {
                  readerSessionId: content.key,
                  bookId: content.bookId,
                  chapterId: content.chapterId,
                  contentRevision: content.contentRevision,
                  theme: content.theme,
                  blocks,
                  ...(checkpoints === undefined ? {} : { mode: 'ordered-chapter', checkpoints }),
                  jobId: crypto.randomUUID(),
                  configRevision: config?.revision ?? 0,
                  settings: publicConfig(config),
                } as unknown as UiJson;
                const result = await record.vm!.invoke('decorate', input, signal);
                await this.store.assertCall(session, session.fence, 'reader.decorations.changed');
                if (config)
                  requireStore((await this.store.readConfig(session))?.revision === config.revision, 'CONFIG_CHANGED');
                this.guard(record);
                signal.throwIfAborted();
                requireStore(record.paintVersion === version, 'REGISTRATION_CHANGED');
                requireStore(
                  uiRecord(result) &&
                    Array.isArray(result.layers) &&
                    result.layers.every(
                      (layer) =>
                        uiRecord(layer) &&
                        typeof layer.id === 'string' &&
                        record.row.manifest!.contributes.decorations.includes(layer.id),
                    ),
                  'INVALID_DECORATION',
                );
                if (checkpoints !== undefined)
                  requireStore(
                    uiRecord(result.checkpoints) && uiKeys(result.checkpoints, ordered),
                    'INVALID_CHECKPOINT',
                  );
                return result;
              };
              const visible = await compute(content.blocks);
              if (!ordered.length) return visible;
              await authority();
              const streamed = await record.orderedCache.run(
                key,
                content,
                actions!.adapter,
                signal,
                authority,
                (blocks, state) => compute(blocks, state),
              );
              requireStore(
                uiRecord(visible) &&
                  Array.isArray(visible.layers) &&
                  uiRecord(streamed) &&
                  Array.isArray(streamed.layers),
                'INVALID_DECORATION',
              );
              return {
                layers: [...visible.layers, ...streamed.layers],
              } as UiJson;
            },
          }),
        );
      } catch {
        paint.invalidate(record.row.pluginId);
      }
    }
    if (this.paint === paint && !this.closed) paint.refresh(plans);
  }
  async startSession(): Promise<void> {
    const first = !this.appStarted;
    this.appStarted = true;
    await this.reconcile();
    if (!first) return;
    for (const r of [...this.records.values()]) {
      try {
        await this.event(r, 'app.ready');
      } catch {
        this.stop(r, 'APP_READY_FAILED');
      }
    }
  }
  async setReader(present: boolean): Promise<void> {
    const previous = this.reader;
    const generation = ++this.readerGeneration;
    this.reader = present;
    if (!present) this.paint?.update();
    await this.reconcile();
    for (const r of this.records.values()) {
      if (generation !== this.readerGeneration || this.closed) break;
      try {
        await this.event(r, present ? (previous ? 'reader.contextChanged' : 'reader.entered') : 'reader.exited');
      } catch {
        this.stop(r, 'READER_EVENT_FAILED');
      }
    }
  }
  async settings(id: string): Promise<{ schema: UiJson; config: UiJson }> {
    const row = await this.currentRow(id);
    if (!this.options.off && row.enabled && row.manifest?.entries.controller) await this.ensure(row).ready;
    const config = await this.store.inspectConfig(id, row.revision);
    return { schema: (config?.schema ?? null) as unknown as UiJson, config: publicConfig(config) };
  }
  homeSections() {
    return this.home.sections();
  }
  homeFeed(id: string, section: string, signal?: AbortSignal) {
    return this.home.feed(id, section, signal);
  }
  homeCover(id: string, section: string, url: string, signal?: AbortSignal) {
    return this.home.cover(id, section, url, signal);
  }
  /** Bounded FIFO admission; only startup is retried, never a dispatched guest operation. */
  private async admitHome(row: Installation, signal?: AbortSignal): Promise<Running> {
    signal?.throwIfAborted();
    requireStore(!this.closed, 'SERVICE_CLOSED');
    requireStore(this.homeAdmissions.size < 32, 'WORKER_LIMIT');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    this.homeAdmissions.add(abort);
    const deadline = Date.now() + 30_000;
    try {
      for (;;) {
        abort.signal.throwIfAborted();
        requireStore(!this.closed, 'SERVICE_CLOSED');
        if (this.homeAdmissions.values().next().value === abort) {
          const current = await this.currentRow(row.pluginId);
          abort.signal.throwIfAborted();
          requireStore(
            current.enabled &&
              current.installationId === row.installationId &&
              current.revision === row.revision &&
              current.active === row.active,
            'CONTEXT_STALE',
          );
          try {
            const record = this.ensure(current);
            // Protect startup and authority-check gaps as well as the VM invocation itself.
            record.homeCalls++;
            return record;
          } catch (error) {
            if (!(error instanceof UiStoreError && error.code === 'WORKER_LIMIT')) throw error;
          }
        }
        const remaining = deadline - Date.now();
        requireStore(remaining > 0, 'WORKER_LIMIT');
        await sleepControllerJob(Math.min(50, remaining), abort.signal);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.homeAdmissions.delete(abort);
    }
  }
  private async invokeHomeFeed(row: Installation, section: string, signal?: AbortSignal): Promise<UiJson> {
    const record = await this.admitHome(row, signal);
    try {
      signal?.throwIfAborted();
      if (!record.active) {
        requireStore(row.manifest?.activation.includes('onHome'), 'NOT_ACTIVE');
        await this.activate(record);
      }
      await this.store.assertSession(record.session!, record.session!.fence, 'home.feed');
      this.guard(record);
      signal?.throwIfAborted();
      const result = await record.vm!.invoke('homeFeed', { id: section }, signal);
      await this.store.assertSession(record.session!, record.session!.fence, 'home.feed');
      this.guard(record);
      signal?.throwIfAborted();
      return result;
    } finally {
      record.homeCalls--;
    }
  }
  async command(id: string, command: string, value: UiJson = null, signal?: AbortSignal): Promise<UiJson> {
    const row = await this.currentRow(id);
    requireStore(row.manifest?.contributes.commands.includes(command), 'UNKNOWN_COMMAND');
    const record = this.ensure(row);
    await record.ready;
    if (!record.active) {
      requireStore(row.manifest!.activation.includes('onCommand'), 'NOT_ACTIVE');
      await this.activate(record);
    }
    await this.store.assertSession(record.session!, record.session!.fence, 'commands.register');
    this.guard(record);
    const result = await record.vm!.invoke('command', { id: command, value }, signal);
    await this.store.assertSession(record.session!, record.session!.fence);
    this.guard(record);
    return result;
  }
  /** Calls only this UI session's already-active controller; no generic host RPC or implicit activation. */
  async callFromView(caller: PluginSession, handler: string, value: UiJson, signal: AbortSignal): Promise<UiJson> {
    requireStore(!this.options.off && !this.closed && !signal.aborted, 'VIEW_UNAVAILABLE');
    requireStore(
      typeof handler === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(handler) && isUiJson(value, 65536),
      'INVALID_ARGUMENT',
    );
    const row = await this.store.controllerForView(caller);
    signal.throwIfAborted();
    const record = this.records.get(row.pluginId);
    requireStore(record && record.row.revision === row.revision && record.active, 'NOT_ACTIVE');
    this.guard(record);
    await this.store.assertSession(record.session!, record.session!.fence);
    signal.throwIfAborted();
    const result = await record.vm!.invoke('handler', { id: handler, value }, signal);
    await this.store.controllerForView(caller);
    await this.store.assertSession(record.session!, record.session!.fence);
    this.guard(record);
    signal.throwIfAborted();
    requireStore(
      uiRecord(result) &&
        typeof result.ok === 'boolean' &&
        uiKeys(result, result.ok ? ['ok', 'value'] : ['ok', 'code']),
      'INVALID_RESULT',
    );
    requireStore(result.ok, result.code === 'UNKNOWN_HANDLER' ? 'UNKNOWN_HANDLER' : 'HANDLER_FAILED');
    return result.value;
  }
  /** Host view lifetime lease; iframe mounting remains a separate adapter. Closing never stops the controller. */
  async openView(id: string, view: string): Promise<() => Promise<void>> {
    requireStore(!this.options.off, 'PLUGINS_DISABLED');
    const row = await this.currentRow(id);
    requireStore(row.manifest?.contributes.views.includes(view), 'UNKNOWN_VIEW');
    const viewSession = await this.store.openSession(id, 'ui', row.revision);
    try {
      await this.store.assertSession(viewSession, viewSession.fence, 'ui.render');
    } finally {
      this.store.closeSession(viewSession);
    }
    const record = this.ensure(row);
    await record.ready;
    if (row.manifest!.activation.includes('onView')) await this.activate(record);
    this.guard(record);
    record.views++;
    await this.event(record, 'view.opened', { id: view });
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      record.views--;
      if (!record.stopped) {
        try {
          await this.event(record, 'view.closed', { id: view });
        } catch {
          this.stop(record);
        }
      }
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const abort of this.homeAdmissions) abort.abort();
    this.home.close();
    this.listeners.clear();
    this.actions?.close();
    this.actions = undefined;
    this.unbind();
    this.paint?.close();
    this.paint = undefined;
    clearInterval(this.poll);
    this.stopAll();
    await this.tasks?.close();
    this.owners?.close();
    await Promise.allSettled([...this.cleanup]);
  }
}
