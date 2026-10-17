import { validateExtensionManifest } from './index';
import { describe, expect, it } from 'vitest';
import { validateBoaaPackageManifest } from './package-manifest';
import { validateBrowserUiManifest } from './ui-package-manifest';
import { validatePlatformManifest } from './plugin-platform-manifest';
import { uiManifestFixture } from './ui-test-fixture';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { isBoaaExtensionFilename, normalizeBrandRecord } from './brand-compat';

// Real input dialects, rather than aliases of the new fixture: old archives retain their original bytes.
function legacyManifest() {
  const manifest = examplePackageManifest();
  return {
    ...manifest,
    packageFormat: 'moya.extension.package',
    extension: { ...manifest.extension, engine: { moyaApi: 1 } },
    execution: { ...manifest.execution, kind: 'moya-js' },
  };
}
describe('old extension manifest dialects', () => {
  it('normalizes the old source package format, engine key and execution kind', () => {
    const input = legacyManifest();
    const result = validateBoaaPackageManifest(input);
    expect(result).toMatchObject({
      ok: true,
      manifest: {
        packageFormat: 'boaa.extension.package',
        extension: { engine: { boaaApi: 1 } },
        execution: { kind: 'boaa-js' },
      },
    });
    expect(input.packageFormat).toBe('moya.extension.package');
    expect(input.extension.engine).toEqual({ moyaApi: 1 });
  });
  it.each([
    'moya.internal',
    'noveldesk.internal',
    'boaa.internal',
    'moya.external.example',
    'moya.ai.tts.book-preparation',
  ])('retains reserved namespace protection for %s', (id) => {
    const input = legacyManifest();
    input.extension.id = id;
    expect(validateBoaaPackageManifest(input).ok).toBe(false);
  });
  it('does not let a legacy engine key override an explicitly incompatible new engine', () => {
    const input = legacyManifest();
    expect(
      validateBoaaPackageManifest({ ...input, extension: { ...input.extension, engine: { moyaApi: 1, boaaApi: 999 } } })
        .ok,
    ).toBe(false);
  });
  it('reads the old browser UI package format', () => {
    const input = { ...uiManifestFixture(), packageFormat: 'moya.extension.package' };
    expect(validateBrowserUiManifest(input)).toMatchObject({
      ok: true,
      manifest: { packageFormat: 'boaa.extension.package' },
    });
  });
  it('reads the old platform package format', () => {
    const input = {
      packageFormat: 'moya.extension.package',
      packageVersion: 3,
      apiVersion: 2,
      extension: { id: 'org.example.legacy', name: 'Example', version: '1.0.0' },
      license: 'MIT',
      entries: { controller: { path: 'dist/controller.js', permissions: ['commands.register'] } },
      activation: ['onCommand'],
      features: { required: ['commands.register'], optional: [] },
      contributes: { commands: ['example'], views: [], decorations: [] },
      requestedAccess: { storageKiB: 0, contentScopes: [] },
    };
    expect(validatePlatformManifest(input)).toMatchObject({
      ok: true,
      manifest: { packageFormat: 'boaa.extension.package' },
    });
  });
  it.each(['sample.moyaext', 'sample.boaaext', 'SAMPLE.MOYAEXT'])('accepts the %s file suffix', (name) => {
    expect(isBoaaExtensionFilename(name)).toBe(true);
  });
  it('rejects executable lookalike suffixes and accessor metadata', () => {
    expect(isBoaaExtensionFilename('sample.boaaext.exe')).toBe(false);
    let called = false;
    const value = Object.defineProperty({}, 'moyaApi', {
      get() {
        called = true;
        return 1;
      },
      enumerable: true,
    });
    normalizeBrandRecord(value);
    expect(called).toBe(false);
  });
});

it('keeps persisted built-in workflow IDs within the corresponding legacy namespace only', () => {
  const manifest = {
    ...examplePackageManifest().extension,
    id: 'boaa.ai',
    contributes: {
      analysisWorkflows: [
        { id: 'moya.ai.tts.book-preparation', schemaVersion: 1, title: 'Example', target: 'book', kind: 'managed' },
      ],
    },
  };
  expect(validateExtensionManifest(manifest)).toMatchObject({
    ok: true,
    manifest: { contributes: { analysisWorkflows: [{ id: 'moya.ai.tts.book-preparation' }] } },
  });
  expect(validateExtensionManifest({ ...manifest, id: 'org.example.unrelated' }).ok).toBe(false);
});
