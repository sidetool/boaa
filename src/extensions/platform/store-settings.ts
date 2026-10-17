import { isUiJson, uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
import { UiPluginDatabase } from '../ui/store-db';
import { requireStore, canonicalJson } from '../ui/store-model';
import { authorize, getInstallation, getConfig, putConfig } from './store-transactions';
import type { ConfigRow, ConfigProposal, PluginSession } from './store-model';
import type { PlatformStoreAccess } from './store-access';
import {
  settingsDefaults,
  validateSettingsSchema,
  validateSettingsValue,
  type SettingsSchema,
} from './settings-schema';
export function checkConfigProposal(proposal: ConfigProposal): void {
  requireStore(
    isUiJson(proposal, 84 * 1024) &&
      uiRecord(proposal) &&
      uiKeys(proposal, ['expectedRevision', 'schema', 'value']) &&
      uiInteger(proposal.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1),
    'INVALID_ARGUMENT',
  );
  validateSettingsValue(proposal.schema, proposal.value);
}

/** Owns config validation, compare-and-swap and abort-bound transactions; never caches grants. */
export class PlatformSettingsStore {
  constructor(
    private readonly db: UiPluginDatabase,
    private readonly access: Pick<PlatformStoreAccess, 'host' | 'session'>,
  ) {}
  /** Host settings/recovery UI may read a disabled installation without executing code. */
  async inspectConfig(id: string, expectedRevision: number): Promise<ConfigRow | undefined> {
    const { scope, guard } = this.access.host();
    return this.db.run('readonly', guard, async (tx) => {
      const install = await getInstallation(tx, scope, id);
      requireStore(install && !install.tombstone && install.revision === expectedRevision, 'INSTALL_CONFLICT');
      return getConfig(tx, install);
    });
  }
  /** User-owned settings editor; never exposed as a guest RPC. Revision and schema remain fenced. */
  async writeHostConfig(id: string, revision: number, proposal: ConfigProposal): Promise<ConfigRow> {
    checkConfigProposal(proposal);
    const copy = structuredClone(proposal);
    const { scope, guard } = this.access.host();
    return this.db.run('readwrite', guard, async (tx) => {
      const install = await getInstallation(tx, scope, id);
      requireStore(install && !install.tombstone && install.revision === revision, 'INSTALL_CONFLICT');
      const old = await getConfig(tx, install);
      requireStore(
        old && canonicalJson(old.schema as unknown as UiJson) === canonicalJson(copy.schema as unknown as UiJson),
        'CONFIG_MIGRATION_REQUIRED',
      );
      return putConfig(tx, install, old, copy);
    });
  }
  async readConfig(session: PluginSession): Promise<ConfigRow | undefined> {
    const { guard, binding } = this.access.session(session);
    requireStore(binding.role !== 'task', 'PERMISSION_DENIED');
    return this.db.run('readonly', guard, async (tx) => getConfig(tx, await authorize(tx, binding, 'settings.own')));
  }
  async registerSettings(session: PluginSession, schema: SettingsSchema): Promise<ConfigRow> {
    validateSettingsSchema(schema);
    const copy = structuredClone(schema);
    const { guard, binding } = this.access.session(session);
    return this.db.run('readwrite', guard, async (tx) => {
      const install = await authorize(tx, binding, 'settings.own');
      requireStore(
        binding.role === 'controller' || (binding.role === 'ui' && !install.manifest?.entries.controller),
        'PERMISSION_DENIED',
      );
      const old = await getConfig(tx, install);
      if (old) {
        requireStore(
          canonicalJson(old.schema as unknown as UiJson) === canonicalJson(copy as unknown as UiJson),
          'CONFIG_MIGRATION_REQUIRED',
        );
        return old;
      }
      return putConfig(tx, install, undefined, { expectedRevision: 0, schema: copy, value: settingsDefaults(copy) });
    });
  }
  async writeConfig(session: PluginSession, proposal: ConfigProposal, signal?: AbortSignal): Promise<ConfigRow> {
    checkConfigProposal(proposal);
    const copy = structuredClone(proposal);
    const { guard, binding } = this.access.session(session);
    requireStore(binding.role !== 'task', 'PERMISSION_DENIED');
    const check = () => {
      guard();
      requireStore(!signal?.aborted, 'CANCELLED');
    };
    const abort = () => this.db.invalidate();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await this.db.run('readwrite', check, async (tx) => {
        const install = await authorize(tx, binding, 'settings.own');
        const old = await getConfig(tx, install);
        requireStore(
          old && canonicalJson(old.schema as unknown as UiJson) === canonicalJson(copy.schema as unknown as UiJson),
          'CONFIG_MIGRATION_REQUIRED',
        );
        return putConfig(tx, install, old, copy);
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
