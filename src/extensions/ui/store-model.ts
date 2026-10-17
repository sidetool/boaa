import type { BrowserUiManifest, UiPermission } from '@boaa/extension-contracts/ui-package';
import { isUiJson, uiRecord, uiString } from '../../../packages/extension-contracts/ui-json';
import type { UiJson, UiMethodMap } from '@boaa/extension-contracts/ui-protocol';

export const UI_STORE_LIMITS = Object.freeze({
  profileBytes: 32 * 1024 * 1024,
  archiveBytes: 128 * 1024 * 1024,
  installations: 128,
  receipts: 128,
  receiptTtlMs: 5 * 60 * 1000,
  markers: 128,
  reviews: 16,
  reviewTtlMs: 5 * 60 * 1000,
});
export type UiPluginScope =
  | { kind: 'local'; profileId: string; libraryId: string }
  | { kind: 'remote'; profileId: string; serverId: string; accountId: string; libraryId: string };
export function scopeKey(scope: UiPluginScope): string {
  if (!isUiJson(scope, 4096) || !uiRecord(scope) || !uiString(scope.profileId, 256) || !uiString(scope.libraryId, 256))
    throw new UiStoreError('INVALID_ARGUMENT');
  if (scope.kind === 'local' && Object.keys(scope).sort().join() === 'kind,libraryId,profileId')
    return JSON.stringify(['local', scope.profileId, scope.libraryId]);
  if (
    scope.kind === 'remote' &&
    Object.keys(scope).sort().join() === 'accountId,kind,libraryId,profileId,serverId' &&
    uiString(scope.serverId, 256) &&
    uiString(scope.accountId, 256)
  )
    return JSON.stringify(['remote', scope.profileId, scope.serverId, scope.accountId, scope.libraryId]);
  throw new UiStoreError('INVALID_ARGUMENT');
}
export class UiStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'UiStoreError';
  }
}
export function requireStore(ok: unknown, code: string): asserts ok {
  if (!ok) throw new UiStoreError(code);
}
export const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
export interface Installation {
  scope: string;
  pluginId: string;
  revision: number;
  installationId: string;
  enabled: boolean;
  tombstone: boolean;
  active?: string;
  previous?: string;
  publisher?: string;
  provenance: string;
  manifest?: BrowserUiManifest;
}
export interface ArchiveRow {
  scope: string;
  pluginId: string;
  digest: string;
  archive: Blob;
  provenance: string;
}
export interface GrantRow {
  scope: string;
  pluginId: string;
  installationId: string;
  digest: string;
  revision: number;
  permissions: UiPermission[];
}
export interface NamespaceUsage {
  id: string;
  bytes: number;
  entries: number;
  sequence: number;
}
export interface ProfileUsage {
  id: 'profile';
  dataBytes: number;
  archiveBytes: number;
  installations: number;
}
export interface KvRow {
  scope: string;
  installationId: string;
  key: string;
  value: UiJson;
  revision: number;
}
export interface ReceiptRow {
  scope: string;
  installationId: string;
  key: string;
  hash: string;
  revision: number;
  receiptId: string;
  expiresAt: number;
}
export interface RuntimeMarker {
  scope: string;
  installationId: string;
  pluginId: string;
  instanceId: string;
  tabId: string;
  sessionId: string;
  digest: string;
  revision: number;
  startedAt: number;
}
export interface SessionBinding {
  scope: string;
  pluginId: string;
  installationId: string;
  digest: string;
  revision: number;
}
/** Opaque host handle. The bridge must never accept a guest-supplied replacement. */
export interface UiPluginSession {
  readonly handle: string;
}
export interface InstallReview {
  readonly digest: string;
  readonly pluginId: string;
  readonly expectedRevision: number;
  readonly manifest: BrowserUiManifest;
  readonly publisher?: string;
  readonly provenance: string;
  readonly publisherChanged: boolean;
  readonly unsigned: boolean;
  readonly sourceChanged: boolean;
  readonly downgrade: boolean;
  readonly sameVersionReplacement: boolean;
  readonly currentDataBytes: number;
}
export interface InstallApproval {
  digest: string;
  permissions: UiPermission[];
  enabled: boolean;
  data: 'preserve' | 'reset';
  allowPublisherChange?: boolean;
  allowDowngrade?: boolean;
  allowSameVersionReplacement?: boolean;
  allowUnsignedDataReuse?: boolean;
}
export type StorageMethod = Extract<keyof UiMethodMap, `storage.${string}`>;
export const namespaceUsage = (id: string): NamespaceUsage => ({ id, bytes: 0, entries: 0, sequence: 0 });
export const profileUsage = (): ProfileUsage => ({ id: 'profile', dataBytes: 0, archiveBytes: 0, installations: 0 });
export function canonicalJson(value: UiJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',') +
    '}'
  );
}
