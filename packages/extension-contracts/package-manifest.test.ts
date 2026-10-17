import { describe, expect, it } from 'vitest';
import { isBoaaPackagePath, validateBoaaPackageManifest } from './package-manifest';

export const examplePackageManifest = () => ({
  packageFormat: 'boaa.extension.package',
  packageVersion: 1,
  extension: {
    manifestVersion: 1,
    id: 'org.example.catalog',
    name: '예제 소스',
    version: '1.0.0',
    engine: { boaaApi: 1 },
    permissions: ['external.source.list', 'external.source.download'],
    contributes: {
      externalSources: [
        {
          schemaVersion: 2,
          id: 'org.example.catalog.source',
          title: '예제',
          kind: 'catalog',
          runtimes: ['tauri-native', 'self-host-gateway'],
          capabilities: ['browse', 'release-list', 'release-download', 'document-content'],
          seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
        },
      ],
    },
  },
  execution: { kind: 'boaa-js', apiVersion: 1, entry: 'dist/main.js' },
  requestedAccess: { networkOrigins: ['https://catalog.example'], storageKiB: 0 },
  license: 'MIT',
});

describe('installable package contract', () => {
  it('keeps the existing integer extension API and supports the serialized package envelope', () => {
    expect(validateBoaaPackageManifest(examplePackageManifest()).ok).toBe(true);
    const input = examplePackageManifest();
    input.extension.engine.boaaApi = 2;
    expect(validateBoaaPackageManifest(input).ok).toBe(false);
  });
  it('rejects trusted claims, core namespace takeover and foreign contribution IDs', () => {
    expect(validateBoaaPackageManifest({ ...examplePackageManifest(), trusted: true }).ok).toBe(false);
    const input = examplePackageManifest();
    input.extension.id = 'boaa.external';
    expect(validateBoaaPackageManifest(input).ok).toBe(false);
    input.extension.id = 'org.example.catalog';
    input.extension.contributes.externalSources[0].id = 'org.other.source';
    expect(validateBoaaPackageManifest(input).ok).toBe(false);
  });
  it('does not grant React or native execution through package metadata', () => {
    const input = examplePackageManifest();
    input.extension.permissions.push('reader.addon.render');
    expect(validateBoaaPackageManifest(input)).toMatchObject({ ok: false, code: 'unsupported_package_api' });
    expect(
      validateBoaaPackageManifest({ ...examplePackageManifest(), execution: { kind: 'shell', entry: 'cmd.exe' } }).ok,
    ).toBe(false);
  });
  it.each([
    'http://catalog.example',
    'https://catalog.example/path',
    'https://user:pass@catalog.example',
    'https://*.example',
    'https://localhost',
  ])('rejects broad or ambiguous network access: %s', (origin) => {
    const input = examplePackageManifest();
    input.requestedAccess.networkOrigins = [origin];
    expect(validateBoaaPackageManifest(input).ok).toBe(false);
  });
  it.each([
    '../main.js',
    '/main.js',
    'C:/main.js',
    'dist\\main.js',
    'dist/../main.js',
    'dist/CON.js',
    'dist/file.js:ads',
    'dist//main.js',
    'dist/main.js.',
  ])('rejects nonportable extraction path: %s', (path) => {
    expect(isBoaaPackagePath(path)).toBe(false);
  });
  it('allows only portable package paths', () => {
    expect(isBoaaPackagePath('dist/main.js')).toBe(true);
    expect(isBoaaPackagePath('assets/cover-1.png')).toBe(true);
  });
});
