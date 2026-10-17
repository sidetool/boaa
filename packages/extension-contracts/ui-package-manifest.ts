import { normalizeBrandRecord } from './brand-compat';
import { isUiJson, uiInteger, uiKeys, uiRecord, uiString } from './ui-json';
import { BOAA_PACKAGE_LIMITS } from './package-manifest';

export const UI_PERMISSIONS = [
  'ui.panel.render',
  'commands.register',
  'reader.selection.consume',
  'storage.own',
] as const;
export const UI_FEATURES = [
  'ui.readerAddonTabs',
  'commands.register',
  'reader.selection.consume',
  'storage.own',
] as const;
export type UiPermission = (typeof UI_PERMISSIONS)[number];
export type UiFeature = (typeof UI_FEATURES)[number];
export interface BrowserUiManifest {
  readonly packageFormat: 'boaa.extension.package';
  readonly packageVersion: 2;
  readonly extension: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly permissions: readonly UiPermission[];
    readonly contributes: {
      readonly readerAddonTabs: readonly { readonly id: string; readonly title: string; readonly order?: number }[];
      readonly commands?: readonly {
        readonly id: string;
        readonly title: string;
        readonly locations: readonly ['reader.selection'];
        readonly opensPanel: string;
      }[];
    };
  };
  readonly execution: { readonly kind: 'browser-ui'; readonly apiVersion: 1; readonly entry: 'dist/ui.js' };
  readonly requires: {
    readonly hostApi: { readonly major: 1; readonly minMinor: 0 };
    readonly features: readonly UiFeature[];
  };
  readonly requestedAccess: {
    readonly networkOrigins: readonly [];
    readonly storageKiB: number;
    readonly contentScopes: readonly 'selection:explicit'[];
  };
  readonly license: string;
}
export type UiManifestValidation =
  | { ok: true; manifest: BrowserUiManifest }
  | { ok: false; code: 'invalid_ui_manifest' | 'unsupported_ui_api'; path: string };
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(v);
function uniqueSubset(v: unknown, values: readonly string[]): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= values.length &&
    v.every((item) => typeof item === 'string' && values.includes(item)) &&
    new Set(v).size === v.length
  );
}
function version(v: unknown): boolean {
  if (
    typeof v !== 'string' ||
    v.length > 96 ||
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(v)
  )
    return false;
  return v
    .split('-')
    .slice(1)
    .join('-')
    .split('.')
    .every((part) => !/^0\d+$/.test(part));
}
/** Initial UI profile only. New methods, origins and contribution kinds require explicit later revisions. */
export function validateBrowserUiManifest(input: unknown): UiManifestValidation {
  input = normalizeBrandRecord(input);
  const invalid = (path: string): UiManifestValidation => ({ ok: false, code: 'invalid_ui_manifest', path });
  const unsupported = (path: string): UiManifestValidation => ({ ok: false, code: 'unsupported_ui_api', path });
  if (
    !isUiJson(input, BOAA_PACKAGE_LIMITS.manifestBytes) ||
    !uiRecord(input) ||
    !uiKeys(input, [
      'packageFormat',
      'packageVersion',
      'extension',
      'execution',
      'requires',
      'requestedAccess',
      'license',
    ])
  )
    return invalid('package');
  if (input.packageFormat !== 'boaa.extension.package') return invalid('packageFormat');
  if (input.packageVersion !== 2) return unsupported('packageVersion');
  const execution = input.execution;
  if (!uiRecord(execution) || !uiKeys(execution, ['kind', 'apiVersion', 'entry'])) return invalid('execution');
  if (execution.kind !== 'browser-ui' || execution.apiVersion !== 1 || execution.entry !== 'dist/ui.js')
    return unsupported('execution');
  const requires = input.requires;
  if (
    !uiRecord(requires) ||
    !uiKeys(requires, ['hostApi', 'features']) ||
    !uiRecord(requires.hostApi) ||
    !uiKeys(requires.hostApi, ['major', 'minMinor'])
  )
    return invalid('requires');
  if (requires.hostApi.major !== 1 || requires.hostApi.minMinor !== 0 || !uniqueSubset(requires.features, UI_FEATURES))
    return unsupported('requires');
  const ext = input.extension;
  if (
    !uiRecord(ext) ||
    !uiKeys(ext, ['id', 'name', 'version', 'permissions', 'contributes'], ['description']) ||
    !identifier(ext.id) ||
    /^(boaa|boaa)\./.test(ext.id) ||
    !uiString(ext.name, 128) ||
    !version(ext.version) ||
    (ext.description !== undefined && !uiString(ext.description, 2048)) ||
    !uniqueSubset(ext.permissions, UI_PERMISSIONS)
  )
    return invalid('extension');
  const contributions = ext.contributes;
  if (
    !uiRecord(contributions) ||
    !uiKeys(contributions, ['readerAddonTabs'], ['commands']) ||
    !Array.isArray(contributions.readerAddonTabs) ||
    contributions.readerAddonTabs.length !== 1
  )
    return invalid('extension.contributes');
  const panel = contributions.readerAddonTabs[0];
  const owns = (id: unknown) => identifier(id) && id.startsWith(`${ext.id}.`);
  if (
    !uiRecord(panel) ||
    !uiKeys(panel, ['id', 'title'], ['order']) ||
    !owns(panel.id) ||
    !uiString(panel.title, 128) ||
    (panel.order !== undefined && !uiInteger(panel.order, -10000, 10000))
  )
    return invalid('extension.contributes.readerAddonTabs');
  const commands = contributions.commands === undefined ? [] : contributions.commands;
  if (!Array.isArray(commands) || commands.length > 10) return invalid('extension.contributes.commands');
  const ids = new Set([panel.id]);
  for (const command of commands) {
    if (
      !uiRecord(command) ||
      !uiKeys(command, ['id', 'title', 'locations', 'opensPanel']) ||
      !owns(command.id) ||
      ids.has(command.id) ||
      !uiString(command.title, 128) ||
      !Array.isArray(command.locations) ||
      command.locations.length !== 1 ||
      command.locations[0] !== 'reader.selection' ||
      command.opensPanel !== panel.id
    )
      return invalid('extension.contributes.commands');
    ids.add(command.id);
  }
  if (
    !ext.permissions.includes('ui.panel.render') ||
    !requires.features.includes('ui.readerAddonTabs') ||
    (commands.length > 0 && !ext.permissions.includes('commands.register'))
  )
    return invalid('extension.permissions');
  const access = input.requestedAccess;
  if (
    !uiRecord(access) ||
    !uiKeys(access, ['networkOrigins', 'storageKiB', 'contentScopes']) ||
    !Array.isArray(access.networkOrigins) ||
    access.networkOrigins.length !== 0 ||
    !uiInteger(access.storageKiB, 0, 1024) ||
    !uniqueSubset(access.contentScopes, ['selection:explicit']) ||
    access.storageKiB > 0 !== ext.permissions.includes('storage.own') ||
    access.contentScopes.includes('selection:explicit') !== ext.permissions.includes('reader.selection.consume')
  )
    return invalid('requestedAccess');
  if (ext.permissions.includes('reader.selection.consume') && !requires.features.includes('reader.selection.consume'))
    return invalid('requires.features');
  if (!uiString(input.license, 128)) return invalid('license');
  return { ok: true, manifest: input as unknown as BrowserUiManifest };
}
