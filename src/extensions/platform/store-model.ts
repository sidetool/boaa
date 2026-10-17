import type { EntryRole, PlatformManifest, PlatformPermission } from '@boaa/extension-contracts/platform-package';
import type { PlatformFence } from '../../../packages/extension-contracts/plugin-platform-sdk';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import type { SettingsSchema } from './settings-schema';
import type { PluginDatabaseLayout } from '../ui/store-db';
export type PayloadFormat = 'package' | 'single-js';
export type RoleGrants = Partial<Record<EntryRole, PlatformPermission[]>>;
export interface Installation {
  scope: string;
  pluginId: string;
  installationId: string;
  revision: number;
  enabled: boolean;
  tombstone: boolean;
  active?: string;
  previous?: string;
  publisher?: string;
  provenance: string;
  manifest?: PlatformManifest;
}
export interface PayloadRow {
  scope: string;
  pluginId: string;
  digest: string;
  format: PayloadFormat;
  /** New writes use bytes; Blob remains readable for existing installations. */
  blob: Blob | ArrayBuffer;
  provenance: string;
}
export interface GrantRow {
  scope: string;
  pluginId: string;
  installationId: string;
  digest: string;
  revision: number;
  roles: RoleGrants;
}
export interface ConfigRow {
  scope: string;
  installationId: string;
  digest: string;
  revision: number;
  schema: SettingsSchema;
  value: Record<string, UiJson>;
}
export interface ConfigProposal {
  expectedRevision: number;
  schema: SettingsSchema;
  value: Record<string, UiJson>;
}
export interface InstallReview {
  readonly pluginId: string;
  readonly digest: string;
  readonly format: PayloadFormat;
  readonly manifest: PlatformManifest;
  readonly expectedRevision: number;
  readonly configRevision: number;
  readonly publisher?: string;
  readonly publisherChanged: boolean;
  readonly sourceChanged: boolean;
  readonly downgrade: boolean;
  readonly sameVersionReplacement: boolean;
}
export interface InstallApproval {
  digest: string;
  roles: RoleGrants;
  enabled: boolean;
  data: 'reset' | 'preserve';
  allowPublisherChange?: boolean;
  allowUnsignedDataReuse?: boolean;
  allowDowngrade?: boolean;
  allowSameVersionReplacement?: boolean;
  /** Host-prepared, validated migration result, committed atomically with package activation. No guest function accepted. */
  config?: ConfigProposal;
}
export interface PluginSession {
  readonly handle: string;
  readonly role: EntryRole;
  readonly fence: Readonly<PlatformFence>;
}
export interface SessionBinding {
  scope: string;
  pluginId: string;
  role: EntryRole;
  fence: PlatformFence;
  epoch: number;
}
export interface RuntimeMarker {
  scope: string;
  installationId: string;
  instanceId: string;
  pluginId: string;
  role: EntryRole;
  fence: PlatformFence;
  startedAt: number;
}
export const PLATFORM_STORE_LIMITS = {
  installs: 128,
  archiveBytes: 128 * 1024 * 1024,
  configBytes: 64 * 1024,
  schemaBytes: 16 * 1024,
  profileConfigBytes: 8 * 1024 * 1024,
  reviews: 16,
  reviewTtlMs: 300_000,
  sessions: 128,
  markers: 128,
} as const;
export const platformLayout: PluginDatabaseLayout = {
  stores: ['installations', 'archives', 'grants', 'config', 'runtime-markers', 'usage'],
  initialize(db) {
    db.createObjectStore('installations', { keyPath: ['scope', 'pluginId'] }).createIndex('scope', 'scope');
    db.createObjectStore('archives', { keyPath: ['scope', 'pluginId', 'digest'] }).createIndex('owner', [
      'scope',
      'pluginId',
    ]);
    db.createObjectStore('grants', { keyPath: ['scope', 'pluginId'] });
    db.createObjectStore('config', { keyPath: ['scope', 'installationId'] });
    db.createObjectStore('runtime-markers', { keyPath: ['scope', 'installationId', 'instanceId'] }).createIndex(
      'scope',
      'scope',
    );
    db.createObjectStore('usage', { keyPath: 'id' });
  },
};
