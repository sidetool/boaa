import { PlatformSettingsStore, checkConfigProposal } from './store-settings';
import { PlatformMarkerStore } from './store-markers';
import type { PlatformStoreAccess } from './store-access';
import { platformCallPolicy } from './platform-call-policy';
import type { RetirementJournal } from './retirement-journal';
import { isUiJson, uiRecord, uiKeys, uiString } from '@boaa/extension-contracts/ui-json';
import type { EntryRole, PlatformManifest, PlatformPermission } from '@boaa/extension-contracts/platform-package';
import type { PlatformFence } from '../../../packages/extension-contracts/plugin-platform-sdk';
import { verifyPlatformPackage, verifyPlatformSingleJs } from '../packages/platform-package';
import { comparePackageVersions } from '../packages/package-installer';
import { UiPluginDatabase, request } from '../ui/store-db';
import { requireStore, scopeKey, canonicalJson, type UiPluginScope } from '../ui/store-model';
import {
  authorize,
  getInstallation,
  getConfig,
  putConfig,
  purgeConfig,
  keepPayloads,
  readMarkers,
  usage,
} from './store-transactions';
import {
  platformLayout,
  PLATFORM_STORE_LIMITS as limits,
  type PayloadFormat,
  type InstallReview,
  type InstallApproval,
  type Installation,
  type PayloadRow,
  type GrantRow,
  type ConfigRow,
  type ConfigProposal,
  type PluginSession,
  type SessionBinding,
  type RuntimeMarker,
} from './store-model';
import type { SettingsSchema } from './settings-schema';
interface Verified {
  blob: Blob;
  format: PayloadFormat;
  digest: string;
  manifest: PlatformManifest;
  publisher?: string;
  sources: Readonly<Record<string, string>>;
}
async function verify(blob: Blob, format: PayloadFormat): Promise<Verified> {
  requireStore(format === 'package' || format === 'single-js', 'INVALID_ARGUMENT');
  if (format === 'single-js') {
    const p = await verifyPlatformSingleJs(blob);
    return { blob, format, digest: p.digest, manifest: p.manifest, sources: { 'dist/controller.js': p.source } };
  }
  const p = await verifyPlatformPackage(blob);
  return {
    blob,
    format,
    digest: p.digest,
    manifest: p.manifest,
    publisher: p.publisherFingerprint,
    sources: p.sources,
  };
}
export type SettingsMigrationRunner = (
  request: { source: string; input: { fromVersion: number; value: ConfigRow['value'] }; fence: PlatformFence },
  signal: AbortSignal,
) => Promise<unknown>;
interface Pending {
  verified: Verified;
  review: InstallReview;
  epoch: number;
  provenance: string;
  expiresAt: number;
}
/** Host-only durable authority. No runtime is started by any operation on this store. */
export class PlatformPluginStore {
  private readonly db: UiPluginDatabase;
  private scope: string;
  private scopeId = crypto.randomUUID();
  private epoch = 1;
  private closed = false;
  private suspended = false;
  private readonly settings: PlatformSettingsStore;
  private readonly markers: PlatformMarkerStore;
  private readonly now: () => number;
  private readonly windowSessionId = crypto.randomUUID();
  private reviews = new Map<InstallReview, Pending>();
  private sessions = new Map<PluginSession, SessionBinding>();
  constructor(
    scope: UiPluginScope,
    options: { name?: string; factory?: IDBFactory; now?: () => number; retirements?: RetirementJournal } = {},
  ) {
    this.scope = scopeKey(scope);
    this.now = options.now ?? Date.now;
    this.db = new UiPluginDatabase(options.factory, `boaa.js-plugins.v1:${options.name ?? 'default'}`, platformLayout);
    const access: PlatformStoreAccess = {
      host: () => ({ scope: this.scope, guard: this.guard() }),
      session: (session) => this.access(session),
      retire: (session) => {
        const { binding } = this.access(session),
          epoch = this.epoch;
        const guard = () => requireStore(!this.closed && this.epoch === epoch, 'CONTEXT_STALE');
        this.closeSession(session);
        return { binding, guard };
      },
    };
    this.settings = new PlatformSettingsStore(this.db, access);
    this.markers = new PlatformMarkerStore(this.db, access, this.now, options.retirements);
  }
  private guard() {
    const epoch = this.epoch;
    return () => requireStore(!this.closed && !this.suspended && this.epoch === epoch, 'CONTEXT_STALE');
  }
  changeScope(scope: UiPluginScope): void {
    requireStore(!this.closed, 'CONTEXT_STALE');
    this.scope = scopeKey(scope);
    this.scopeId = crypto.randomUUID();
    this.epoch++;
    this.sessions.clear();
    this.reviews.clear();
    this.db.invalidate();
  }
  /** Revoke all operations immediately while allowing already-captured stopped-instance cleanup. */
  suspend(): void {
    this.suspended = true;
    this.sessions.clear();
    this.reviews.clear();
    this.db.invalidate();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.sessions.clear();
    this.reviews.clear();
    this.db.invalidate();
    await this.db.close();
  }
  list(): Promise<Installation[]> {
    const scope = this.scope;
    return this.db.run('readonly', this.guard(), (tx) =>
      request(tx.objectStore('installations').index('scope').getAll(scope)),
    );
  }
  async inspect(blob: Blob, format: PayloadFormat, provenance: string): Promise<InstallReview> {
    requireStore(uiString(provenance, 1024), 'INVALID_ARGUMENT');
    const guard = this.guard(),
      scope = this.scope,
      epoch = this.epoch;
    guard();
    const verified = await verify(blob, format);
    guard();
    const { old, config } = await this.db.run('readonly', guard, async (tx) => {
      const old = await getInstallation(tx, scope, verified.manifest.extension.id);
      return { old, config: old ? await getConfig(tx, old) : undefined };
    });
    const comparison = old?.manifest
      ? comparePackageVersions(verified.manifest.extension.version, old.manifest.extension.version)
      : 0;
    const summary: InstallReview = {
      pluginId: verified.manifest.extension.id,
      digest: verified.digest,
      format,
      manifest: verified.manifest,
      expectedRevision: old?.revision ?? 0,
      configRevision: config?.revision ?? 0,
      publisher: verified.publisher,
      publisherChanged: Boolean(old?.active && old.publisher !== verified.publisher),
      sourceChanged: Boolean(old?.active && old.provenance !== provenance),
      downgrade: Boolean(old?.active && comparison < 0),
      sameVersionReplacement: Boolean(old?.active && old.active !== verified.digest && comparison === 0),
    };
    for (const [key, p] of this.reviews) if (p.expiresAt <= this.now()) this.reviews.delete(key);
    requireStore(this.reviews.size < limits.reviews, 'QUOTA_EXCEEDED');
    const review = Object.freeze(structuredClone(summary));
    this.reviews.set(review, {
      verified,
      review: summary,
      epoch,
      provenance,
      expiresAt: this.now() + limits.reviewTtlMs,
    });
    return review;
  }
  async inspectRetained(id: string, version: 'active' | 'previous'): Promise<InstallReview> {
    requireStore(version === 'active' || version === 'previous', 'INVALID_ARGUMENT');
    const guard = this.guard(),
      scope = this.scope;
    const { row, old } = await this.db.run('readonly', guard, async (tx) => {
      const old = await getInstallation(tx, scope, id);
      requireStore(old?.[version] && !old.tombstone, 'PACKAGE_UNAVAILABLE');
      const row = await request<PayloadRow | undefined>(tx.objectStore('archives').get([scope, id, old[version]]));
      requireStore(row, 'PACKAGE_UNAVAILABLE');
      return { row, old };
    });
    guard();
    const review = await this.inspect(new Blob([row.blob]), row.format, row.provenance);
    guard();
    if (review.digest !== old[version] || review.expectedRevision !== old.revision) {
      this.reviews.delete(review);
      requireStore(false, 'INSTALL_CONFLICT');
    }
    return review;
  }
  install(review: InstallReview, approval: InstallApproval): Promise<Installation> {
    return this.installInternal(review, approval);
  }
  /** Host-only: runner must execute approved source in an isolated, bounded VM, never in this realm. */
  async installWithMigration(
    review: InstallReview,
    approval: InstallApproval,
    runner: SettingsMigrationRunner,
    signal: AbortSignal,
  ): Promise<Installation> {
    const invalidate = () => this.db.invalidate();
    signal.addEventListener('abort', invalidate);
    try {
      return await this.installInternal(review, approval, { runner, signal });
    } finally {
      signal.removeEventListener('abort', invalidate);
    }
  }
  private async installInternal(
    review: InstallReview,
    approval: InstallApproval,
    migration?: { runner: SettingsMigrationRunner; signal: AbortSignal },
  ): Promise<Installation> {
    const p = this.reviews.get(review),
      contextGuard = this.guard(),
      scope = this.scope;
    const guard = () => {
      contextGuard();
      requireStore(!migration?.signal.aborted, 'CANCELLED');
    };
    guard();
    requireStore(p && p.epoch === this.epoch && p.expiresAt > this.now(), 'REVIEW_EXPIRED');
    requireStore(
      isUiJson(approval, 96 * 1024) &&
        uiRecord(approval) &&
        uiKeys(
          approval,
          ['digest', 'roles', 'enabled', 'data'],
          ['allowPublisherChange', 'allowUnsignedDataReuse', 'allowDowngrade', 'allowSameVersionReplacement', 'config'],
        ),
      'INVALID_ARGUMENT',
    );
    const decision = structuredClone(approval);
    requireStore(
      decision.digest === p.verified.digest &&
        typeof decision.enabled === 'boolean' &&
        ['reset', 'preserve'].includes(decision.data),
      'APPROVAL_MISMATCH',
    );
    for (const flag of [
      decision.allowPublisherChange,
      decision.allowUnsignedDataReuse,
      decision.allowDowngrade,
      decision.allowSameVersionReplacement,
    ])
      requireStore(flag === undefined || typeof flag === 'boolean', 'INVALID_ARGUMENT');
    requireStore(
      uiRecord(decision.roles) && uiKeys(decision.roles, [], ['controller', 'ui', 'task']),
      'PERMISSION_DENIED',
    );
    for (const [role, permissions] of Object.entries(decision.roles)) {
      const entry = p.verified.manifest.entries[role as EntryRole];
      requireStore(
        entry &&
          Array.isArray(permissions) &&
          new Set(permissions).size === permissions.length &&
          permissions.every((permission) => entry.permissions.includes(permission)),
        'PERMISSION_DENIED',
      );
    }
    // Explicit empty grants permit code with no host capabilities. No panel permission is added.
    requireStore(!decision.enabled || Object.keys(decision.roles).length > 0, 'PERMISSION_DENIED');
    requireStore(!p.review.publisherChanged || decision.allowPublisherChange, 'PUBLISHER_REVIEW_REQUIRED');
    requireStore(!p.review.downgrade || decision.allowDowngrade, 'DOWNGRADE_REVIEW_REQUIRED');
    requireStore(!p.review.sameVersionReplacement || decision.allowSameVersionReplacement, 'VERSION_REVIEW_REQUIRED');
    if (decision.config) checkConfigProposal(decision.config);
    // Snapshot approved input before verification; IDB byte payloads also work where Blob storage fails.
    const payloadBytes = await p.verified.blob.arrayBuffer();
    const fresh = await verify(new Blob([payloadBytes]), p.verified.format);
    guard();
    requireStore(fresh.digest === decision.digest && p.expiresAt > this.now(), 'APPROVAL_MISMATCH');
    const preserve = decision.data === 'preserve';
    const snapshot = async (tx: IDBTransaction) => {
      const id = fresh.manifest.extension.id;
      const old = await getInstallation(tx, scope, id);
      requireStore(
        (old?.revision ?? 0) === p.review.expectedRevision && p.review.expectedRevision < Number.MAX_SAFE_INTEGER,
        'INSTALL_CONFLICT',
      );
      const oldConfig = old ? await getConfig(tx, old) : undefined;
      requireStore((oldConfig?.revision ?? 0) === p.review.configRevision, 'CONFIG_CONFLICT');

      requireStore(
        !preserve ||
          (old &&
            old.active &&
            !old.tombstone &&
            old.publisher === fresh.publisher &&
            (fresh.publisher || (old.provenance === p.provenance && decision.allowUnsignedDataReuse))),
        'DATA_REUSE_REQUIRES_REVIEW',
      );
      if (migration) {
        requireStore(
          old && !old.enabled && oldConfig && preserve && old.active !== fresh.digest,
          'MIGRATION_REQUIRES_STOPPED_UPDATE',
        );
        requireStore(!(await readMarkers(tx, scope)).some((marker) => marker.pluginId === id), 'RECOVERY_REQUIRED');
      }
      return { id, old, oldConfig };
    };
    if (migration) {
      requireStore(
        !decision.config && decision.enabled && decision.roles.controller?.includes('settings.own'),
        'PERMISSION_DENIED',
      );
      const entry = fresh.manifest.entries.controller;
      requireStore(entry, 'MIGRATION_CONTROLLER_REQUIRED');
      const { oldConfig, old } = await this.db.run('readonly', guard, snapshot);
      guard();
      // One explicit attempt per review. Failure needs a fresh inspection/approval; never auto-retry guest code.
      requireStore(this.reviews.get(review) === p && p.expiresAt > this.now(), 'REVIEW_EXPIRED');
      this.reviews.delete(review);
      const result = await migration.runner(
        {
          source: fresh.sources[entry.path],
          input: { fromVersion: oldConfig!.schema.version, value: oldConfig!.value },
          fence: {
            installationId: old!.installationId,
            digest: fresh.digest,
            scopeId: this.scopeId,
            windowSessionId: this.windowSessionId,
            instanceId: crypto.randomUUID(),
            generation: p.review.expectedRevision + 1,
          },
        },
        migration.signal,
      );
      guard();
      requireStore(
        isUiJson(result, 84 * 1024) && uiRecord(result) && uiKeys(result, ['schema', 'value']),
        'INVALID_CONFIG_SCHEMA',
      );
      decision.config = {
        expectedRevision: p.review.configRevision,
        schema: result.schema as unknown as SettingsSchema,
        value: result.value as ConfigProposal['value'],
      };
      checkConfigProposal(decision.config);
    }
    const result = await this.db.run('readwrite', guard, async (tx) => {
      requireStore(p.expiresAt > this.now(), 'REVIEW_EXPIRED');
      const { id, old, oldConfig } = await snapshot(tx);
      requireStore(
        !preserve || !oldConfig || old?.active === fresh.digest || decision.config,
        'CONFIG_REVIEW_REQUIRED',
      );
      if (decision.config)
        requireStore(decision.config.expectedRevision === (oldConfig?.revision ?? 0), 'CONFIG_CONFLICT');
      const installed: Installation = {
        scope,
        pluginId: id,
        installationId: preserve ? old!.installationId : crypto.randomUUID(),
        revision: p.review.expectedRevision + 1,
        enabled: decision.enabled,
        tombstone: false,
        active: fresh.digest,
        previous: old?.active === fresh.digest ? old.previous : old?.active,
        publisher: fresh.publisher,
        provenance: p.provenance,
        manifest: fresh.manifest,
      };
      const u = await usage(tx);
      if (!old) u.installs++;
      requireStore(u.installs <= limits.installs, 'QUOTA_EXCEEDED');
      tx.objectStore('usage').put(u);
      if (!preserve && old) await purgeConfig(tx, old);
      if (decision.config)
        await putConfig(tx, installed, preserve ? oldConfig : undefined, {
          ...decision.config,
          expectedRevision: preserve ? decision.config.expectedRevision : 0,
        });
      await keepPayloads(tx, scope, id, [fresh.digest, ...(installed.previous ? [installed.previous] : [])], {
        scope,
        pluginId: id,
        digest: fresh.digest,
        format: fresh.format,
        blob: payloadBytes,
        provenance: p.provenance,
      });
      tx.objectStore('installations').put(installed);
      tx.objectStore('grants').put({
        scope,
        pluginId: id,
        installationId: installed.installationId,
        revision: installed.revision,
        digest: fresh.digest,
        roles: decision.roles,
      } satisfies GrantRow);
      return installed;
    });
    this.reviews.delete(review);
    return result;
  }
  async disable(id: string, expectedRevision: number, remove = false): Promise<void> {
    const scope = this.scope;
    await this.db.run('readwrite', this.guard(), async (tx) => {
      const old = await getInstallation(tx, scope, id);
      requireStore(
        old && !old.tombstone && old.revision === expectedRevision && expectedRevision < Number.MAX_SAFE_INTEGER,
        'INSTALL_CONFLICT',
      );
      const next: Installation = { ...old, enabled: false, revision: expectedRevision + 1 };
      if (remove) {
        await purgeConfig(tx, old);
        await keepPayloads(tx, scope, id, []);
        next.tombstone = true;
        delete next.active;
        delete next.previous;
        delete next.manifest;
        delete next.publisher;
      }
      tx.objectStore('installations').put(next);
      tx.objectStore('grants').delete([scope, id]);
    });
  }
  async openSession(id: string, role: EntryRole, expectedRevision: number): Promise<PluginSession> {
    requireStore(['controller', 'ui', 'task'].includes(role), 'INVALID_ARGUMENT');
    const guard = this.guard(),
      scope = this.scope,
      epoch = this.epoch;
    const binding = await this.db.run('readonly', guard, async (tx) => {
      const install = await getInstallation(tx, scope, id);
      requireStore(install?.active && install.revision === expectedRevision, 'PACKAGE_GENERATION_CHANGED');
      const binding: SessionBinding = {
        scope,
        pluginId: id,
        role,
        epoch,
        fence: {
          scopeId: this.scopeId,
          installationId: install.installationId,
          digest: install.active,
          generation: install.revision,
          windowSessionId: this.windowSessionId,
          instanceId: crypto.randomUUID(),
        },
      };
      await authorize(tx, binding);
      return binding;
    });
    guard();
    requireStore(this.sessions.size < limits.sessions, 'QUOTA_EXCEEDED');
    const session = Object.freeze({
      handle: crypto.randomUUID(),
      role,
      fence: Object.freeze(structuredClone(binding.fence)),
    });
    this.sessions.set(session, binding);
    return session;
  }
  /** A task receives fresh role authority from the same reviewed generation, never the owner's grants. */
  async openTaskSession(owner: PluginSession): Promise<PluginSession> {
    const { guard, binding } = this.access(owner);
    await this.assertCall(owner, owner.fence, 'tasks.run');
    guard();
    const session = await this.openSession(binding.pluginId, 'task', binding.fence.generation);
    try {
      await this.assertSession(owner, owner.fence);
      guard();
      return session;
    } catch (error) {
      this.closeSession(session);
      throw error;
    }
  }
  closeSession(session: PluginSession): void {
    this.sessions.delete(session);
    this.db.invalidate();
  }
  private access(session: PluginSession, fence: PlatformFence = session.fence) {
    const binding = this.sessions.get(session);
    requireStore(binding && binding.epoch === this.epoch && !this.closed && !this.suspended, 'CONTEXT_STALE');
    requireStore(
      isUiJson(fence, 8192) &&
        canonicalJson(fence as unknown as import('@boaa/extension-contracts/ui-json').UiJson) ===
          canonicalJson(binding.fence as unknown as import('@boaa/extension-contracts/ui-json').UiJson),
      'CONTEXT_STALE',
    );
    const guard = () =>
      requireStore(
        !this.closed && !this.suspended && this.sessions.get(session) === binding && binding.epoch === this.epoch,
        'CONTEXT_STALE',
      );
    return { guard, binding };
  }
  async assertSession(session: PluginSession, fence: PlatformFence, permission?: PlatformPermission): Promise<void> {
    const { guard, binding } = this.access(session, fence);
    await this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding, permission);
    });
  }
  /** Resolve from an actual UI session, never from a guest-supplied plugin ID. */
  async controllerForView(session: PluginSession): Promise<Installation> {
    const { guard, binding } = this.access(session);
    requireStore(binding.role === 'ui', 'PERMISSION_DENIED');
    return this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding, 'ui.render');
      return authorize(tx, { ...binding, role: 'controller' });
    });
  }
  /** Method authorization for the upcoming broker. Unimplemented methods fail closed. */
  async assertCall(session: PluginSession, fence: PlatformFence, method: string): Promise<void> {
    const { guard, binding } = this.access(session, fence);
    const policy = platformCallPolicy(method);
    requireStore(policy && policy.roles.includes(binding.role), 'METHOD_NOT_ALLOWED');
    await this.db.run('readonly', guard, async (tx) => {
      const install = await authorize(tx, binding, policy.permission);
      if (method === 'reader.decorations.changed') await authorize(tx, binding, 'reader.content.visible');
      if (method === 'tasks.run') requireStore(install.manifest?.entries.task, 'TASK_UNAVAILABLE');
      if (method === 'settings.register')
        requireStore(binding.role === 'controller' || !install.manifest?.entries.controller, 'PERMISSION_DENIED');
    });
  }
  async sessionPermissions(session: PluginSession): Promise<PlatformPermission[]> {
    const { guard, binding } = this.access(session);
    return this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding);
      const grant: GrantRow = await request(tx.objectStore('grants').get([binding.scope, binding.pluginId]));
      return grant.roles[binding.role]!;
    });
  }
  /** Rechecks stored bytes and grant revision immediately before the caller delivers this role's code. */
  async loadEntry(session: PluginSession): Promise<string> {
    const { guard, binding } = this.access(session);
    const row = await this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding);
      return request<PayloadRow | undefined>(
        tx.objectStore('archives').get([binding.scope, binding.pluginId, binding.fence.digest]),
      );
    });
    requireStore(row, 'PACKAGE_UNAVAILABLE');
    const verified = await verify(new Blob([row.blob]), row.format);
    guard();
    requireStore(verified.digest === binding.fence.digest, 'PACKAGE_GENERATION_CHANGED');
    await this.assertSession(session, binding.fence);
    guard();
    const entry = verified.manifest.entries[binding.role];
    requireStore(entry && typeof verified.sources[entry.path] === 'string', 'PACKAGE_UNAVAILABLE');
    return verified.sources[entry.path];
  }
  /** Host settings/recovery UI may read a disabled installation without executing code. */
  inspectConfig(id: string, expectedRevision: number): Promise<ConfigRow | undefined> {
    return this.settings.inspectConfig(id, expectedRevision);
  }
  writeHostConfig(id: string, revision: number, proposal: ConfigProposal): Promise<ConfigRow> {
    return this.settings.writeHostConfig(id, revision, proposal);
  }
  readConfig(session: PluginSession): Promise<ConfigRow | undefined> {
    return this.settings.readConfig(session);
  }
  registerSettings(session: PluginSession, schema: SettingsSchema): Promise<ConfigRow> {
    return this.settings.registerSettings(session, schema);
  }
  writeConfig(session: PluginSession, proposal: ConfigProposal, signal?: AbortSignal): Promise<ConfigRow> {
    return this.settings.writeConfig(session, proposal, signal);
  }
  startMarker(session: PluginSession): Promise<void> {
    return this.markers.startMarker(session);
  }
  retireSession(session: PluginSession): () => Promise<void> {
    return this.markers.retireSession(session);
  }
  finishRetirements(): Promise<void> {
    return this.markers.finishRetirements();
  }
  unfinishedMarkers(): Promise<RuntimeMarker[]> {
    return this.markers.unfinishedMarkers();
  }
  acknowledgeMarkers(id: string, expectedRevision: number): Promise<void> {
    return this.markers.acknowledgeMarkers(id, expectedRevision);
  }
}
