import { normalizeBrandRecord } from './brand-compat';
import { isUiJson, uiKeys, uiRecord, uiString, uiInteger } from './ui-json';

/** V3 static package contract. Product activation remains gated until G3. */
export const PLATFORM_PERMISSIONS = [
  'http.request',
  'settings.own',
  'storage.own',
  'commands.register',
  'ui.render',
  'reader.content.visible',
  'reader.decorations',
  'reader.state',
  'reader.control',
  'reader.input',
  'reader.content.book',
  'reader.annotations.read',
  'reader.annotations.write',
] as const;
export const PLATFORM_FEATURES = [
  'http.request',
  'settings.schema',
  'storage.own',
  'commands.register',
  'ui.views',
  'reader.content.visible',
  'reader.decorations',
  'reader.state',
  'reader.control',
  'reader.input',
  'reader.content.book',
  'reader.annotations.read',
  'reader.annotations.write',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type PlatformFeature = (typeof PLATFORM_FEATURES)[number];
export type Activation = 'onReader' | 'onCommand' | 'onAppSession' | 'onView';
export type EntryRole = 'controller' | 'ui' | 'task';
export interface PlatformManifest {
  packageFormat: 'boaa.extension.package';
  packageVersion: 3;
  apiVersion: 2;
  extension: { id: string; name: string; version: string };
  license: string;
  entries: Partial<Record<EntryRole, { path: string; permissions: PlatformPermission[] }>>;
  activation: Activation[];
  features: { required: PlatformFeature[]; optional: PlatformFeature[] };
  contributes: { commands: string[]; views: string[]; decorations: string[]; connections?: string[] };
  requestedAccess: { storageKiB: number; contentScopes: ('visible:nearby' | 'current:book')[] };
}
export type PlatformValidation =
  { ok: true; manifest: PlatformManifest } | { ok: false; code: 'INVALID_MANIFEST' | 'UNSUPPORTED_API'; path: string };
const roles = ['controller', 'ui', 'task'] as const;
const activations = ['onReader', 'onCommand', 'onAppSession', 'onView'];
const subset = (v: unknown, choices: readonly string[]): v is string[] =>
  Array.isArray(v) &&
  v.length <= choices.length &&
  v.every((x) => typeof x === 'string' && choices.includes(x)) &&
  new Set(v).size === v.length;
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 32 &&
  v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(x)) &&
  new Set(v).size === v.length;
export function validatePlatformManifest(value: unknown): PlatformValidation {
  value = normalizeBrandRecord(value);
  const bad = (
    path: string,
    code: 'INVALID_MANIFEST' | 'UNSUPPORTED_API' = 'INVALID_MANIFEST',
  ): PlatformValidation => ({ ok: false, code, path });
  if (
    !isUiJson(value, 16384) ||
    !uiRecord(value) ||
    !uiKeys(value, [
      'packageFormat',
      'packageVersion',
      'apiVersion',
      'extension',
      'license',
      'entries',
      'activation',
      'features',
      'contributes',
      'requestedAccess',
    ])
  )
    return bad('manifest');
  if (value.packageFormat !== 'boaa.extension.package') return bad('packageFormat');
  if (value.packageVersion !== 3 || value.apiVersion !== 2) return bad('version', 'UNSUPPORTED_API');
  const e = value.extension;
  if (
    !uiRecord(e) ||
    !uiKeys(e, ['id', 'name', 'version']) ||
    typeof e.id !== 'string' ||
    e.id.length > 128 ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(e.id) ||
    /^(boaa|boaa)\./.test(e.id) ||
    !uiString(e.name, 128) ||
    typeof e.version !== 'string' ||
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(e.version) ||
    !uiString(value.license, 128)
  )
    return bad('extension');
  if (!uiRecord(value.entries) || !uiKeys(value.entries, [], roles) || !Object.keys(value.entries).length)
    return bad('entries');
  const permissions = new Set<string>();
  for (const role of roles) {
    const entry = value.entries[role];
    if (entry === undefined) continue;
    if (
      !uiRecord(entry) ||
      !uiKeys(entry, ['path', 'permissions']) ||
      entry.path !== `dist/${role}.js` ||
      !subset(entry.permissions, PLATFORM_PERMISSIONS)
    )
      return bad(`entries.${role}`);
    entry.permissions.forEach((p) => permissions.add(p));
  }
  if (!subset(value.activation, activations) || !value.activation.length) return bad('activation');
  const { controller, ui, task } = value.entries;
  if (
    (!controller && value.activation.some((a) => a !== 'onView')) ||
    (!controller && !ui) ||
    (task && !controller) ||
    (value.activation.includes('onView') && !ui)
  )
    return bad('activation.roles');
  const f = value.features;
  if (
    !uiRecord(f) ||
    !uiKeys(f, ['required', 'optional']) ||
    !subset(f.required, PLATFORM_FEATURES) ||
    !subset(f.optional, PLATFORM_FEATURES)
  )
    return bad('features', 'UNSUPPORTED_API');
  const optional = f.optional;
  if (f.required.some((x) => optional.includes(x))) return bad('features');
  const c = value.contributes;
  if (
    !uiRecord(c) ||
    !uiKeys(c, ['commands', 'views', 'decorations'], ['connections']) ||
    (c.connections !== undefined && (!ids(c.connections) || c.connections.length > 8)) ||
    !ids(c.commands) ||
    !ids(c.views) ||
    !ids(c.decorations)
  )
    return bad('contributes');
  if (
    permissions.has('http.request') !== (Array.isArray(c.connections) && c.connections.length > 0) ||
    (task && hasHttpTask(task))
  )
    return bad('connections');
  const all = [...c.commands, ...c.views, ...c.decorations];
  if (
    new Set(all).size !== all.length ||
    (c.commands.length && !controller) ||
    (c.decorations.length && !controller) ||
    c.views.length > 0 !== !!ui
  )
    return bad('contributes.roles');
  const hasRolePermission = (role: EntryRole, permission: string) => {
    const entry = value.entries as Record<string, { permissions: string[] }>;
    return entry[role]?.permissions.includes(permission);
  };
  if (
    (c.commands.length && !hasRolePermission('controller', 'commands.register')) ||
    (c.decorations.length &&
      (!hasRolePermission('controller', 'reader.decorations') ||
        !hasRolePermission('controller', 'reader.content.visible'))) ||
    (ui && !hasRolePermission('ui', 'ui.render')) ||
    (value.activation.includes('onCommand') && !c.commands.length)
  )
    return bad('permissions.roles');
  for (const permission of permissions) {
    const feature =
      permission === 'settings.own' ? 'settings.schema' : permission === 'ui.render' ? 'ui.views' : permission;
    if (!f.required.includes(feature)) return bad('features.required');
  }
  const access = value.requestedAccess;
  if (
    !uiRecord(access) ||
    !uiKeys(access, ['storageKiB', 'contentScopes']) ||
    !uiInteger(access.storageKiB, 0, 1024) ||
    !subset(access.contentScopes, ['visible:nearby', 'current:book']) ||
    access.storageKiB > 0 !== permissions.has('storage.own') ||
    access.contentScopes.includes('visible:nearby') !== permissions.has('reader.content.visible') ||
    access.contentScopes.includes('current:book') !== permissions.has('reader.content.book')
  )
    return bad('requestedAccess');
  return { ok: true, manifest: value as unknown as PlatformManifest };
}

function hasHttpTask(task: unknown) {
  return uiRecord(task) && Array.isArray(task.permissions) && task.permissions.includes('http.request');
}
