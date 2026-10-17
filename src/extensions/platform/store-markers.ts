import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { UiPluginDatabase, request } from '../ui/store-db';
import { requireStore, canonicalJson } from '../ui/store-model';
import { authorize, getInstallation, readMarkers } from './store-transactions';
import { PLATFORM_STORE_LIMITS as limits, type PluginSession, type RuntimeMarker } from './store-model';
import type { PlatformStoreAccess } from './store-access';
import type { Retirement, RetirementJournal } from './retirement-journal';

/** Durable instance markers and attested post-stop cleanup. Unknown/crashed instances remain recoverable. */
export class PlatformMarkerStore {
  constructor(
    private readonly db: UiPluginDatabase,
    private readonly access: PlatformStoreAccess,
    private readonly now: () => number,
    private readonly retirements?: RetirementJournal,
  ) {}
  async startMarker(session: PluginSession): Promise<void> {
    const { guard, binding } = this.access.session(session);
    await this.db.run('readwrite', guard, async (tx) => {
      await authorize(tx, binding);
      const store = tx.objectStore('runtime-markers'),
        f = binding.fence;
      requireStore(
        !(await request(store.getKey([binding.scope, f.installationId, f.instanceId]))),
        'DUPLICATE_INSTANCE',
      );
      requireStore((await request(store.count())) < limits.markers, 'QUOTA_EXCEEDED');
      store.put({
        scope: binding.scope,
        installationId: f.installationId,
        instanceId: f.instanceId,
        pluginId: binding.pluginId,
        role: binding.role,
        fence: f,
        startedAt: this.now(),
      } satisfies RuntimeMarker);
    });
  }
  /** Revokes immediately; cleanup may run only AFTER the controller/iframe has actually stopped. Faults retain marker. */
  retireSession(session: PluginSession): () => Promise<void> {
    const { binding, guard } = this.access.retire(session);
    const receipt: Retirement = {
      scope: binding.scope,
      installationId: binding.fence.installationId,
      instanceId: binding.fence.instanceId,
      fence: binding.fence,
    };
    return () => {
      // Invoked by the runtime only after Worker termination / iframe removal.
      this.retirements?.remember(receipt);
      return this.db
        .run('readwrite', guard, async (tx) => {
          const f = binding.fence;
          tx.objectStore('runtime-markers').delete([binding.scope, f.installationId, f.instanceId]);
        })
        .then(() => this.retirements?.forget(receipt));
    };
  }
  /** Resume only previously attested clean shutdowns in the currently authenticated scope. */
  async finishRetirements(): Promise<void> {
    const { scope, guard } = this.access.host();
    const receipts = this.retirements?.pending().filter((r) => r.scope === scope) ?? [];
    for (const receipt of receipts) {
      await this.db.run('readwrite', guard, async (tx) => {
        const key = [receipt.scope, receipt.installationId, receipt.instanceId];
        const marker = await request<RuntimeMarker | undefined>(tx.objectStore('runtime-markers').get(key));
        if (
          marker &&
          canonicalJson(marker.fence as unknown as UiJson) === canonicalJson(receipt.fence as unknown as UiJson)
        )
          tx.objectStore('runtime-markers').delete(key);
      });
      this.retirements?.forget(receipt);
    }
  }
  unfinishedMarkers(): Promise<RuntimeMarker[]> {
    const { scope, guard } = this.access.host();
    return this.db.run('readonly', guard, (tx) => readMarkers(tx, scope));
  }
  async acknowledgeMarkers(id: string, expectedRevision: number): Promise<void> {
    const { scope, guard } = this.access.host();
    await this.db.run('readwrite', guard, async (tx) => {
      const install = await getInstallation(tx, scope, id);
      requireStore(install && !install.enabled && install.revision === expectedRevision, 'INSTALL_CONFLICT');
      for (const row of await readMarkers(tx, scope))
        if (row.pluginId === id) tx.objectStore('runtime-markers').delete([scope, row.installationId, row.instanceId]);
    });
  }
}
