import type { UiPermission } from '@boaa/extension-contracts/ui-package';
import { verifyBrowserUiPackage, type VerifiedBrowserUiPackage } from '../packages/browser-ui-package';
import { comparePackageVersions } from '../packages/package-installer';
import { packageSha256 } from '../packages/package-archive-core';
import { validateUiRequest, type UiMethodMap, type UiJson } from '@boaa/extension-contracts/ui-protocol';
import { isUiJson, uiKeys, uiRecord, uiString } from '../../../packages/extension-contracts/ui-json';
import { UiPluginDatabase, request } from './store-db';
import { authorize, changeInstallation, commitInstallation, readInstallation } from './store-installation';
import { readKv, writeKv, assertStorageResult, type PageCursor } from './store-kv';
import {
  UI_STORE_LIMITS,
  scopeKey,
  requireStore,
  canonicalJson,
  type UiPluginScope,
  type Installation,
  type InstallReview,
  type InstallApproval,
  type SessionBinding,
  type UiPluginSession,
  type ArchiveRow,
  type NamespaceUsage,
  type StorageMethod,
  type RuntimeMarker,
} from './store-model';
export type { UiPluginScope, UiPluginSession, InstallReview, InstallApproval } from './store-model';
export { UiStoreError } from './store-model';
interface PendingReview {
  pkg: VerifiedBrowserUiPackage;
  expectedRevision: number;
  scope: string;
  epoch: number;
  provenance: string;
  expiresAt: number;
  review: InstallReview;
}
interface BoundSession {
  binding: SessionBinding;
  epoch: number;
}
/** Host service only. Not registered in the trusted registry or exposed as a guest API. */
export class UiPluginStore {
  private readonly db: UiPluginDatabase;
  private scope: string;
  private epoch = 1;
  private reviews = new Map<InstallReview, PendingReview>();
  private sessions = new Map<UiPluginSession, BoundSession>();
  private cursors = new Map<
    string,
    { session: UiPluginSession; prefix: string; expiresAt: number; page: PageCursor }
  >();
  constructor(scope: UiPluginScope, options: { name?: string; factory?: IDBFactory; now?: () => number } = {}) {
    this.scope = scopeKey(scope);
    this.now = options.now ?? Date.now;
    this.db = new UiPluginDatabase(options.factory, options.name);
  }
  private readonly now: () => number;
  private scopeGuard() {
    const epoch = this.epoch;
    return () => requireStore(epoch === this.epoch, 'CONTEXT_STALE');
  }
  changeScope(scope: UiPluginScope): void {
    this.scope = scopeKey(scope);
    this.epoch++;
    this.reviews.clear();
    this.sessions.clear();
    this.cursors.clear();
    this.db.invalidate();
  }
  async close(): Promise<void> {
    this.epoch++;
    this.reviews.clear();
    this.sessions.clear();
    this.cursors.clear();
    this.db.invalidate();
    await this.db.close();
  }
  async list(): Promise<Installation[]> {
    const scope = this.scope;
    return this.db.run('readonly', this.scopeGuard(), async (tx) =>
      request(tx.objectStore('installations').index('scope').getAll(scope)),
    );
  }
  async inspect(archive: Blob, provenance: string): Promise<InstallReview> {
    requireStore(uiString(provenance, 1024), 'INVALID_ARGUMENT');
    const guard = this.scopeGuard();
    const scope = this.scope;
    const epoch = this.epoch;
    const pkg = await verifyBrowserUiPackage(archive);
    guard();
    const { old, usage } = await this.db.run('readonly', guard, async (tx) => {
      const old = await readInstallation(tx, scope, pkg.manifest.extension.id);
      const usage: NamespaceUsage | undefined = old
        ? await request(tx.objectStore('usage').get(old.installationId))
        : undefined;
      return { old, usage };
    });
    const comparison = old?.manifest
      ? comparePackageVersions(pkg.manifest.extension.version, old.manifest.extension.version)
      : 0;
    const summary: InstallReview = {
      digest: pkg.digest,
      pluginId: pkg.manifest.extension.id,
      expectedRevision: old?.revision ?? 0,
      manifest: pkg.manifest,
      publisher: pkg.publisherFingerprint,
      provenance,
      publisherChanged: Boolean(old?.active && old.publisher !== pkg.publisherFingerprint),
      unsigned: !pkg.publisherFingerprint,
      sourceChanged: Boolean(old?.active && old.provenance !== provenance),
      downgrade: Boolean(old?.active && comparison < 0),
      sameVersionReplacement: Boolean(old?.active && old.active !== pkg.digest && comparison === 0),
      currentDataBytes: usage?.bytes ?? 0,
    };
    for (const [key, pending] of this.reviews) if (pending.expiresAt <= this.now()) this.reviews.delete(key);
    requireStore(this.reviews.size < UI_STORE_LIMITS.reviews, 'QUOTA_EXCEEDED');
    const review = Object.freeze(structuredClone(summary));
    this.reviews.set(review, {
      pkg,
      scope,
      epoch,
      provenance,
      expectedRevision: summary.expectedRevision,
      expiresAt: this.now() + UI_STORE_LIMITS.reviewTtlMs,
      review: summary,
    });
    return review;
  }
  private async inspectRetained(id: string, version: 'active' | 'previous'): Promise<InstallReview> {
    const guard = this.scopeGuard();
    const scope = this.scope;
    const { row, old } = await this.db.run('readonly', guard, async (tx) => {
      const old = await readInstallation(tx, scope, id);
      requireStore(old?.[version] && !old.tombstone, 'PACKAGE_UNAVAILABLE');
      const row: ArchiveRow | undefined = await request(tx.objectStore('archives').get([scope, id, old[version]]));
      requireStore(row, 'PACKAGE_UNAVAILABLE');
      return { row, old };
    });
    guard();
    const review = await this.inspect(row.archive, row.provenance);
    guard();
    if (review.expectedRevision !== old.revision || review.digest !== old[version]) {
      this.reviews.delete(review);
      requireStore(false, 'INSTALL_CONFLICT');
    }
    return review;
  }
  inspectInstalled(id: string): Promise<InstallReview> {
    return this.inspectRetained(id, 'active');
  }
  inspectRollback(id: string): Promise<InstallReview> {
    return this.inspectRetained(id, 'previous');
  }
  async install(review: InstallReview, approval: InstallApproval): Promise<Installation> {
    const pending = this.reviews.get(review);
    requireStore(
      pending && pending.epoch === this.epoch && pending.scope === this.scope && pending.expiresAt > this.now(),
      'REVIEW_EXPIRED',
    );
    const guard = this.scopeGuard();
    requireStore(
      isUiJson(approval, 4096) &&
        uiRecord(approval) &&
        uiKeys(
          approval,
          ['digest', 'permissions', 'enabled', 'data'],
          ['allowPublisherChange', 'allowDowngrade', 'allowSameVersionReplacement', 'allowUnsignedDataReuse'],
        ),
      'INVALID_ARGUMENT',
    );
    const decision = structuredClone(approval);
    requireStore(
      decision.digest === pending.pkg.digest &&
        typeof decision.enabled === 'boolean' &&
        ['preserve', 'reset'].includes(decision.data),
      'APPROVAL_MISMATCH',
    );
    for (const value of [
      decision.allowPublisherChange,
      decision.allowDowngrade,
      decision.allowSameVersionReplacement,
      decision.allowUnsignedDataReuse,
    ])
      requireStore(value === undefined || typeof value === 'boolean', 'INVALID_ARGUMENT');
    requireStore(
      Array.isArray(decision.permissions) &&
        new Set(decision.permissions).size === decision.permissions.length &&
        decision.permissions.every((p) => pending.pkg.manifest.extension.permissions.includes(p)),
      'PERMISSION_DENIED',
    );
    requireStore(!decision.enabled || decision.permissions.includes('ui.panel.render'), 'PERMISSION_DENIED');
    requireStore(!pending.review.publisherChanged || decision.allowPublisherChange, 'PUBLISHER_REVIEW_REQUIRED');
    requireStore(!pending.review.downgrade || decision.allowDowngrade, 'DOWNGRADE_REVIEW_REQUIRED');
    requireStore(
      !pending.review.sameVersionReplacement || decision.allowSameVersionReplacement,
      'VERSION_REVIEW_REQUIRED',
    );
    const fresh = await verifyBrowserUiPackage(pending.pkg.archive);
    guard();
    requireStore(fresh.digest === decision.digest && pending.expiresAt > this.now(), 'APPROVAL_MISMATCH');
    const result = await this.db.run('readwrite', guard, (tx) =>
      commitInstallation(
        tx,
        pending.scope,
        fresh,
        pending.expectedRevision,
        pending.provenance,
        decision,
        crypto.randomUUID(),
      ),
    );
    this.reviews.delete(review);
    return result;
  }
  async revoke(id: string, expectedRevision: number): Promise<void> {
    const scope = this.scope;
    await this.db.run('readwrite', this.scopeGuard(), (tx) =>
      changeInstallation(tx, scope, id, expectedRevision, false),
    );
  }
  async remove(id: string, expectedRevision: number): Promise<void> {
    const scope = this.scope;
    await this.db.run('readwrite', this.scopeGuard(), (tx) =>
      changeInstallation(tx, scope, id, expectedRevision, true),
    );
  }
  async openSession(id: string, expectedRevision?: number): Promise<UiPluginSession> {
    const guard = this.scopeGuard();
    const scope = this.scope;
    const epoch = this.epoch;
    const binding = await this.db.run('readonly', guard, async (tx) => {
      const install = await readInstallation(tx, scope, id);
      requireStore(install?.active, 'PERMISSION_DENIED');
      requireStore(
        expectedRevision === undefined || install.revision === expectedRevision,
        'PACKAGE_GENERATION_CHANGED',
      );
      const binding: SessionBinding = {
        scope,
        pluginId: id,
        installationId: install.installationId,
        digest: install.active,
        revision: install.revision,
      };
      await authorize(tx, binding);
      return binding;
    });
    requireStore(this.sessions.size < 128, 'QUOTA_EXCEEDED');
    const session = Object.freeze({ handle: crypto.randomUUID() });
    this.sessions.set(session, { binding, epoch });
    return session;
  }
  closeSession(session: UiPluginSession): void {
    this.sessions.delete(session);
    for (const [key, cursor] of this.cursors) if (cursor.session === session) this.cursors.delete(key);
    this.db.invalidate();
  }
  private access(session: UiPluginSession) {
    const saved = this.sessions.get(session);
    requireStore(saved && saved.epoch === this.epoch, 'CONTEXT_STALE');
    const guard = () =>
      requireStore(this.sessions.get(session) === saved && saved.epoch === this.epoch, 'CONTEXT_STALE');
    return { guard, binding: saved.binding };
  }
  async assertSession(session: UiPluginSession, permission: UiPermission = 'ui.panel.render'): Promise<void> {
    const { guard, binding } = this.access(session);
    await this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding, permission);
    });
  }
  /** Host-only: reverify the archive bound to this exact live session before code delivery. */
  async loadSessionPackage(session: UiPluginSession): Promise<VerifiedBrowserUiPackage> {
    const { guard, binding } = this.access(session);
    const row = await this.db.run('readonly', guard, async (tx) => {
      await authorize(tx, binding);
      return request<ArchiveRow | undefined>(
        tx.objectStore('archives').get([binding.scope, binding.pluginId, binding.digest]),
      );
    });
    requireStore(row, 'STORAGE_UNAVAILABLE');
    const pkg = await verifyBrowserUiPackage(row.archive);
    guard();
    requireStore(pkg.digest === binding.digest, 'PACKAGE_GENERATION_CHANGED');
    await this.assertSession(session);
    return pkg;
  }
  async storage<M extends StorageMethod>(
    session: UiPluginSession,
    method: M,
    params: UiMethodMap[M]['params'],
  ): Promise<UiMethodMap[M]['result']> {
    const { guard, binding } = this.access(session);
    requireStore(
      validateUiRequest({
        wireVersion: 1,
        kind: 'request',
        sessionId: 's'.repeat(128),
        requestId: 'r'.repeat(128),
        method,
        params,
      }) && method.startsWith('storage.'),
      'INVALID_ARGUMENT',
    );
    const data = structuredClone(params);
    if (method === 'storage.set' || method === 'storage.remove') {
      // Hashing cannot keep an IDB transaction alive. Recheck authority after hashing, inside the write transaction.
      const hash = await packageSha256(
        new TextEncoder().encode(
          canonicalJson({ method, params: data, digest: binding.digest, revision: binding.revision } as UiJson),
        ),
      );
      guard();
      const result = await this.db.run('readwrite', guard, (tx) =>
        writeKv(
          tx,
          binding,
          method,
          data as UiMethodMap['storage.set' | 'storage.remove']['params'],
          hash,
          crypto.randomUUID(),
          this.now(),
        ),
      );
      assertStorageResult(method, result);
      return result as UiMethodMap[M]['result'];
    }
    const list = data as UiMethodMap['storage.list']['params'];
    const cursor = method === 'storage.list' && list.cursor ? this.cursors.get(list.cursor) : undefined;
    if (method === 'storage.list' && list.cursor)
      requireStore(
        cursor && cursor.session === session && cursor.prefix === (list.prefix ?? '') && cursor.expiresAt > this.now(),
        'CONTEXT_STALE',
      );
    const output = await this.db.run('readonly', guard, (tx) =>
      readKv(
        tx,
        binding,
        method as 'storage.get' | 'storage.list',
        data as UiMethodMap['storage.get' | 'storage.list']['params'],
        cursor?.page,
      ),
    );
    let result = output.result as UiMethodMap[M]['result'];
    if (output.next) {
      for (const [key, value] of this.cursors) if (value.expiresAt <= this.now()) this.cursors.delete(key);
      const prefix = list.prefix ?? '';
      const retained = [...this.cursors].find(
        ([, value]) =>
          value.session === session &&
          value.prefix === prefix &&
          value.page.sequence === output.next!.sequence &&
          value.page.after === output.next!.after,
      );
      const nextCursor = retained?.[0] ?? crypto.randomUUID();
      if (retained) this.cursors.delete(nextCursor); // Touch recency without extending expiry.
      if (this.cursors.size >= 128) {
        // Keep forward pagination bounded without invalidating another session's positions.
        const oldest = [...this.cursors].find(([, value]) => value.session === session);
        requireStore(oldest, 'QUOTA_EXCEEDED');
        this.cursors.delete(oldest[0]);
      }
      this.cursors.set(
        nextCursor,
        retained?.[1] ?? {
          session,
          prefix,
          expiresAt: this.now() + UI_STORE_LIMITS.reviewTtlMs,
          page: output.next,
        },
      );
      result = { ...output.result, nextCursor } as UiMethodMap[M]['result'];
    }
    guard();
    assertStorageResult(method, result);
    return result;
  }
  /** Must complete before executing code. No heartbeat age automatically proves a crash. */
  async startMarker(session: UiPluginSession, tabId: string, instanceId: string): Promise<void> {
    requireStore(uiString(tabId, 128) && uiString(instanceId, 128), 'INVALID_ARGUMENT');
    const { guard, binding } = this.access(session);
    await this.db.run('readwrite', guard, async (tx) => {
      await authorize(tx, binding);
      const store = tx.objectStore('runtime-markers');
      requireStore((await request(store.count())) < UI_STORE_LIMITS.markers, 'QUOTA_EXCEEDED');
      const key = [binding.scope, binding.installationId, instanceId];
      requireStore(!(await request(store.getKey(key))), 'STORAGE_CONFLICT');
      store.add({
        ...binding,
        instanceId,
        tabId,
        sessionId: session.handle,
        startedAt: this.now(),
      } satisfies RuntimeMarker);
    });
  }
  async finishMarker(session: UiPluginSession, instanceId: string): Promise<void> {
    const { guard, binding } = this.access(session);
    return this.clearMarker(session, instanceId, binding, guard);
  }
  /** Revoke now; clear the owned marker only AFTER the caller has destroyed the execution surface. */
  retireSession(session: UiPluginSession, instanceId: string): () => Promise<void> {
    const { binding } = this.access(session);
    const guard = this.scopeGuard();
    this.closeSession(session);
    return () => this.clearMarker(session, instanceId, binding, guard);
  }
  private async clearMarker(
    session: UiPluginSession,
    instanceId: string,
    binding: SessionBinding,
    guard: () => void,
  ): Promise<void> {
    await this.db.run('readwrite', guard, async (tx) => {
      const store = tx.objectStore('runtime-markers');
      const key = [binding.scope, binding.installationId, instanceId];
      const marker: RuntimeMarker | undefined = await request(store.get(key));
      if (
        marker?.digest === binding.digest &&
        marker.revision === binding.revision &&
        marker.sessionId === session.handle
      )
        store.delete(key);
    });
  }
  /** Explicit host recovery after disabling; never infer that another tab is dead from elapsed time. */
  async acknowledgeMarkers(id: string, expectedRevision: number): Promise<void> {
    const scope = this.scope;
    await this.db.run('readwrite', this.scopeGuard(), async (tx) => {
      const install = await readInstallation(tx, scope, id);
      requireStore(install && install.revision === expectedRevision && !install.enabled, 'INSTALL_CONFLICT');
      const store = tx.objectStore('runtime-markers');
      const rows: RuntimeMarker[] = await request(store.index('scope').getAll(scope));
      for (const row of rows)
        if (row.installationId === install.installationId) store.delete([scope, row.installationId, row.instanceId]);
    });
  }
  async unfinishedMarkers(): Promise<RuntimeMarker[]> {
    const scope = this.scope;
    return this.db.run('readonly', this.scopeGuard(), async (tx) =>
      request(tx.objectStore('runtime-markers').index('scope').getAll(scope)),
    );
  }
}
