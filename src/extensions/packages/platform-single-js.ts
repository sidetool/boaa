import { parsePlatformMetadata } from './platform-metadata';
import { uiKeys, uiRecord } from '@boaa/extension-contracts/ui-json';
import { validatePlatformManifest, type PlatformManifest } from '@boaa/extension-contracts/platform-package';
const PREFIX = '/* @boaa-plugin ';
const PREFIXES = [PREFIX, '/* @moya-plugin '];
export const SOURCE_LIMIT = 1024 * 1024;
export function inspectSingleJs(bytes: Uint8Array): { manifest: PlatformManifest; source: string } {
  if (!bytes.length || bytes.length > SOURCE_LIMIT || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))
    throw Error('INVALID_SOURCE');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const prefix = PREFIXES.find((value) => source.startsWith(value));
  if (!prefix || PREFIXES.some((value) => source.indexOf(value, prefix.length) !== -1)) throw Error('INVALID_HEADER');
  const end = source.indexOf('*/', prefix.length);
  if (end < 0 || new TextEncoder().encode(source.slice(0, end)).length > 16384) throw Error('INVALID_HEADER');
  const header = parsePlatformMetadata(source.slice(prefix.length, end));
  if (
    !uiRecord(header) ||
    !uiKeys(
      header,
      ['id', 'version', 'apiVersion', 'license', 'activation', 'permissions', 'features', 'contributes'],
      ['name', 'storageKiB'],
    ) ||
    !uiRecord(header.contributes) ||
    !uiKeys(header.contributes, [], ['commands', 'decorations', 'connections'])
  )
    throw Error('INVALID_HEADER');
  const manifest = {
    packageFormat: 'boaa.extension.package',
    packageVersion: 3,
    apiVersion: header.apiVersion,
    extension: { id: header.id, name: header.name ?? header.id, version: header.version },
    license: header.license,
    entries: { controller: { path: 'dist/controller.js', permissions: header.permissions } },
    activation: header.activation,
    features: { required: header.features, optional: [] },
    contributes: {
      commands: header.contributes.commands ?? [],
      views: [],
      decorations: header.contributes.decorations ?? [],
      ...(header.contributes.connections === undefined ? {} : { connections: header.contributes.connections }),
    },
    requestedAccess: {
      storageKiB: header.storageKiB ?? 0,
      contentScopes: Array.isArray(header.permissions)
        ? [
            ...(header.permissions.includes('reader.content.visible') ? ['visible:nearby'] : []),
            ...(header.permissions.includes('reader.content.book') ? ['current:book'] : []),
          ]
        : [],
    },
  };
  const result = validatePlatformManifest(manifest);
  if (!result.ok) throw Error(`${result.code}:${result.path}`);
  return { manifest: result.manifest, source };
}
