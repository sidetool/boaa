import { isUiJson, uiRecord, uiKeys, uiInteger, uiString } from '@boaa/extension-contracts/ui-json';
import { validatePlatformManifest } from '@boaa/extension-contracts/platform-package';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import {
  PLUGIN_STATE_STORES,
  PLUGIN_STATE_LIMITS,
  pluginStateKey,
  type PluginStateChange,
  type PluginStateStore,
} from '../../../../packages/extension-contracts/plugin-state';
import { verifyPlatformPackage, verifyPlatformSingleJs } from '../../../../src/extensions/packages/platform-package';
import { validateSettingsValue } from '../../../../src/extensions/platform/settings-schema';
import { canonicalJson } from '../../../../src/extensions/ui/store-model';

export interface StoredPluginRow {
  store: PluginStateStore;
  key: string;
  value: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
function assert(ok: unknown, code = 'PLUGIN_STATE_INVALID'): asserts ok {
  if (!ok) throw Error(code);
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) && value.length <= 128;
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function pluginStateRowId(store: string, key: unknown) {
  return JSON.stringify([store, key]);
}

/** Validate bytes without evaluating plugin code. Metadata is computed on the server, never accepted from callers. */
export async function preparePluginStateChanges(input: unknown, scope: string): Promise<StoredPluginRow[]> {
  assert(Array.isArray(input) && input.length > 0 && input.length <= PLUGIN_STATE_LIMITS.changes);
  const seen = new Set<string>(),
    prepared: StoredPluginRow[] = [];
  for (const change of input) {
    assert(
      uiRecord(change) &&
        uiKeys(change, ['store', 'key'], ['value']) &&
        PLUGIN_STATE_STORES.includes(change.store as PluginStateStore),
    );
    const store = change.store as PluginStateStore;
    assert(
      store === 'usage'
        ? typeof change.key === 'string' && change.key.length <= 160
        : Array.isArray(change.key) &&
            change.key.length >= 2 &&
            change.key.length <= 3 &&
            change.key[0] === scope &&
            change.key.every((key) => typeof key === 'string' && key.length <= 1024),
    );
    const key = JSON.stringify(change.key),
      identity = pluginStateRowId(store, change.key);
    assert(!seen.has(identity));
    seen.add(identity);
    if (change.value === undefined) {
      prepared.push({ store, key, value: {} });
      continue;
    }
    assert(uiRecord(change.value));
    const value = change.value;
    assert(JSON.stringify(pluginStateKey(store, value)) === key && (store === 'usage' || value.scope === scope));
    if (store !== 'archives') {
      assert(isUiJson(value, 128 * 1024));
      prepared.push({ store, key, value });
      continue;
    }
    assert(
      uiKeys(value, ['scope', 'pluginId', 'digest', 'format', 'provenance', 'blobBase64']) &&
        identifier(value.pluginId) &&
        digest(value.digest) &&
        ['package', 'single-js'].includes(String(value.format)) &&
        uiString(value.provenance, 1024),
    );
    assert(
      typeof value.blobBase64 === 'string' &&
        value.blobBase64.length <= Math.ceil(BOAA_PACKAGE_LIMITS.archiveBytes / 3) * 4 &&
        /^[A-Za-z0-9+/=]*$/.test(value.blobBase64),
    );
    const bytes = Buffer.from(value.blobBase64, 'base64');
    assert(
      bytes.length > 0 &&
        bytes.length <= BOAA_PACKAGE_LIMITS.archiveBytes &&
        bytes.toString('base64') === value.blobBase64,
    );
    const verified =
      value.format === 'single-js'
        ? await verifyPlatformSingleJs(new Blob([Uint8Array.from(bytes)]))
        : await verifyPlatformPackage(new Blob([Uint8Array.from(bytes)]));
    assert(verified.digest === value.digest && verified.manifest.extension.id === value.pluginId);
    prepared.push({
      store,
      key,
      value,
      metadata: {
        bytes: bytes.length,
        manifest: verified.manifest,
        ...(verified.publisherFingerprint ? { publisher: verified.publisherFingerprint } : {}),
      },
    });
  }
  return prepared;
}

/** Check the entire proposed metadata graph, without loading existing archive payloads into memory. */
export function validatePluginStateGraph(
  rows: StoredPluginRow[],
  previous: StoredPluginRow[],
  changes: PluginStateChange[],
) {
  assert(rows.length <= PLUGIN_STATE_LIMITS.rows, 'PLUGIN_STATE_QUOTA');
  const installations = rows.filter((r) => r.store === 'installations'),
    byId = new Map(installations.map((r) => [r.value.pluginId, r.value]));
  assert(
    installations.length <= 4096 && installations.filter((row) => !row.value.tombstone).length <= 128,
    'PLUGIN_STATE_QUOTA',
  );
  const byInstallation = new Map(
    installations.filter((r) => !r.value.tombstone).map((r) => [r.value.installationId, r.value]),
  );
  assert(byInstallation.size === installations.filter((r) => !r.value.tombstone).length);
  const archives = rows.filter((r) => r.store === 'archives');
  assert(
    archives.length <= 256 &&
      archives.reduce((sum, r) => sum + Number(r.metadata?.bytes ?? 0), 0) <= PLUGIN_STATE_LIMITS.archiveBytes,
    'PLUGIN_STATE_QUOTA',
  );
  for (const { value: r } of installations) {
    assert(
      uiKeys(
        r,
        ['scope', 'pluginId', 'installationId', 'revision', 'enabled', 'tombstone', 'provenance'],
        ['active', 'previous', 'publisher', 'manifest'],
      ) &&
        identifier(r.pluginId) &&
        id(r.installationId) &&
        uiInteger(r.revision, 1, Number.MAX_SAFE_INTEGER - 1) &&
        typeof r.enabled === 'boolean' &&
        typeof r.tombstone === 'boolean' &&
        uiString(r.provenance, 1024),
    );
    if (r.tombstone) {
      assert(
        !r.enabled &&
          r.active === undefined &&
          r.previous === undefined &&
          r.manifest === undefined &&
          r.publisher === undefined,
      );
      continue;
    }
    assert(
      digest(r.active) &&
        (r.previous === undefined || digest(r.previous)) &&
        (r.publisher === undefined || uiString(r.publisher, 256)),
    );
    const validation = validatePlatformManifest(r.manifest);
    assert(validation.ok);
    assert(validation.manifest.extension.id === r.pluginId);
    const active = archives.find((a) => a.value.pluginId === r.pluginId && a.value.digest === r.active);
    assert(
      active &&
        canonicalJson(active.metadata?.manifest as never) === canonicalJson(r.manifest as never) &&
        active.metadata?.publisher === r.publisher &&
        active.value.provenance === r.provenance,
    );
    if (r.previous) assert(archives.some((a) => a.value.pluginId === r.pluginId && a.value.digest === r.previous));
  }
  for (const a of archives) {
    const install = byId.get(a.value.pluginId);
    assert(install && !install.tombstone && [install.active, install.previous].includes(a.value.digest));
  }
  for (const change of changes.filter((c) => c.store === 'installations')) {
    const old = previous.find((r) => r.store === 'installations' && r.key === JSON.stringify(change.key));
    assert(change.value && change.value.revision === (Number(old?.value.revision) || 0) + 1);
  }
  const grants = rows.filter((r) => r.store === 'grants');
  for (const { value: r } of grants) {
    assert(uiKeys(r, ['scope', 'pluginId', 'installationId', 'digest', 'revision', 'roles']) && uiRecord(r.roles));
    const install = byId.get(r.pluginId);
    assert(
      install &&
        !install.tombstone &&
        install.installationId === r.installationId &&
        install.active === r.digest &&
        install.revision === r.revision,
    );
    const manifest = validatePlatformManifest(install.manifest);
    assert(manifest.ok);
    assert(Object.keys(r.roles).length > 0 && Object.keys(r.roles).length <= 3);
    for (const [role, permissions] of Object.entries(r.roles)) {
      assert(['controller', 'ui', 'task'].includes(role) && Array.isArray(permissions));
      const entry = manifest.manifest.entries[role as 'controller' | 'ui' | 'task'];
      assert(
        entry &&
          new Set(permissions).size === permissions.length &&
          permissions.every((p) => entry.permissions.includes(p)),
      );
    }
  }
  for (const { value: r } of installations) if (r.enabled) assert(grants.some((g) => g.value.pluginId === r.pluginId));
  let configBytes = 0,
    kvBytes = 0;
  const namespace = new Map<unknown, { bytes: number; entries: number; maxRevision: number }>();
  for (const { store, value: r } of rows) {
    if (store === 'config') {
      assert(
        uiKeys(r, ['scope', 'installationId', 'digest', 'revision', 'schema', 'value']) &&
          uiInteger(r.revision, 1, Number.MAX_SAFE_INTEGER - 1),
      );
      const install = byInstallation.get(r.installationId);
      assert(install && install.active === r.digest);
      validateSettingsValue(r.schema as never, r.value as never);
      configBytes += size({ schema: r.schema, value: r.value });
    } else if (store === 'kv') {
      assert(
        uiKeys(r, ['scope', 'installationId', 'key', 'value', 'revision']) &&
          uiString(r.key, 128) &&
          isUiJson(r.value, 48 * 1024) &&
          uiInteger(r.revision, 1, Number.MAX_SAFE_INTEGER - 1),
      );
      const install = byInstallation.get(r.installationId);
      assert(install);
      const manifest = validatePlatformManifest(install.manifest);
      assert(manifest.ok);
      const n = namespace.get(r.installationId) ?? { bytes: 0, entries: 0, maxRevision: 0 };
      const length = size({ key: r.key, value: r.value });
      n.bytes += length;
      n.entries++;
      n.maxRevision = Math.max(n.maxRevision, Number(r.revision));
      namespace.set(r.installationId, n);
      kvBytes += length;
      assert(
        n.bytes <= manifest.manifest.requestedAccess.storageKiB * 1024 && n.entries <= PLUGIN_STATE_LIMITS.kvEntries,
        'PLUGIN_STATE_QUOTA',
      );
    } else if (store === 'usage') {
      if (r.id === 'profile')
        assert(
          uiKeys(r, ['id', 'configBytes', 'archiveBytes', 'installs'], ['storageBytes']) &&
            ['configBytes', 'archiveBytes', 'installs'].every((k) => uiInteger(r[k], 0, Number.MAX_SAFE_INTEGER)) &&
            (r.storageBytes === undefined || uiInteger(r.storageBytes, 0, Number.MAX_SAFE_INTEGER)),
        );
      else
        assert(
          typeof r.id === 'string' &&
            r.id.startsWith('kv:') &&
            byInstallation.has(r.id.slice(3)) &&
            uiKeys(r, ['id', 'sequence']) &&
            uiInteger(r.sequence, 0, Number.MAX_SAFE_INTEGER),
        );
    } else if (store === 'preferences') {
      assert(uiKeys(r, ['scope', 'key', 'value']) && r.key === 'reader-input');
      if (r.value !== null) {
        assert(
          uiRecord(r.value) &&
            uiKeys(r.value, ['pluginId', 'installationId', 'revision', 'digest', 'command', 'edge']) &&
            identifier(r.value.pluginId) &&
            id(r.value.installationId) &&
            uiInteger(r.value.revision, 1, Number.MAX_SAFE_INTEGER - 1) &&
            digest(r.value.digest) &&
            uiString(r.value.command, 64) &&
            ['left', 'right', 'keyboard'].includes(String(r.value.edge)),
        );
        // Persisted choices may refer to a retired generation. Runtime fences determine whether they can execute.
      }
    }
  }
  assert(
    configBytes <= PLUGIN_STATE_LIMITS.configBytes && kvBytes <= PLUGIN_STATE_LIMITS.kvBytes,
    'PLUGIN_STATE_QUOTA',
  );
  for (const [installation, n] of namespace)
    assert(
      rows.some(
        (r) => r.store === 'usage' && r.value.id === `kv:${installation}` && Number(r.value.sequence) >= n.maxRevision,
      ),
    );
}
