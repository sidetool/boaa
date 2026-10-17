import { expect, it } from 'vitest';
import { validateBrowserUiManifest } from './ui-package-manifest';
import { validateBoaaPackageManifest } from './package-manifest';
import { uiManifestFixture } from './ui-test-fixture';

it('accepts the RFC initial profile and keeps the source validator closed to V2', () => {
  expect(validateBrowserUiManifest(uiManifestFixture()).ok).toBe(true);
  expect(validateBoaaPackageManifest(uiManifestFixture()).ok).toBe(false);
  const manifest = uiManifestFixture();
  manifest.extension.permissions = ['ui.panel.render'];
  manifest.extension.contributes.commands = [];
  manifest.requestedAccess = { networkOrigins: [], storageKiB: 0, contentScopes: [] };
  manifest.requires.features = ['ui.readerAddonTabs'];
  expect(validateBrowserUiManifest(manifest).ok).toBe(true);
});

it.each([
  ['packageVersion', 1],
  ['execution.kind', 'boaa-js'],
  ['execution.entry', 'dist/main.js'],
  ['execution.apiVersion', 2],
  ['requires.hostApi.minMinor', 1],
  ['requires.features', ['unknown']],
  ['extension.permissions', ['ui.panel.render', 'network.fetch']],
  ['requestedAccess.networkOrigins', ['https://api.example']],
  ['extension.permissions', ['ui.panel.render', 'ui.panel.render']],
  ['extension.id', 'boaa.internal'],
  ['extension.id', 'boaa.internal'],
  ['extension.version', '1.0.0-01'],
  ['extension.version', '01.2.3'],
  ['extension.contributes.readerAddonTabs.0.id', 'org.other.panel'],
  ['extension.contributes.commands.0.id', 'org.example.wordbook.panel'],
  ['extension.contributes.commands.0.opensPanel', 'org.other.panel'],
  ['extension.contributes.commands.0.locations', ['reader.dom']],
  ['extension.contributes.commands', null],
  ['extension.contributes.readerAddonTabs', []],
  ['extension.contributes.commands', Array(11).fill({})],
  ['requestedAccess.contentScopes', []],
  ['requestedAccess.storageKiB', 0],
  ['requestedAccess.storageKiB', 1025],
  ['extension.permissions', ['ui.panel.render', 'reader.selection.consume', 'storage.own']],
  ['extension.contributes.externalSources', []],
  ['extension.engine', { boaaApi: 1 }],
  ['execution.url', 'https://example.org/plugin.js'],
  ['requires.features', ['ui.readerAddonTabs']],
  ['license', 'MIT\n<script>'],
  ['extension.description', 'x'.repeat(2049)],
])('rejects unsupported or inconsistent field %s', (path, value) => {
  const manifest: Record<string, unknown> = uiManifestFixture();
  const keys = path.split('.');
  let parent: Record<string, unknown> = manifest;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  expect(validateBrowserUiManifest(manifest).ok).toBe(false);
});

it('does not execute metadata getters or accept hidden prototype fields', () => {
  let called = false;
  const manifest = uiManifestFixture();
  Object.defineProperty(manifest, 'license', {
    get() {
      called = true;
      return 'MIT';
    },
    enumerable: true,
  });
  expect(validateBrowserUiManifest(manifest).ok).toBe(false);
  expect(called).toBe(false);
  expect(validateBrowserUiManifest(JSON.parse('{"__proto__":{"admin":true}}')).ok).toBe(false);
});
