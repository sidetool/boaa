import { expect, it } from 'vitest';
import { validatePlatformManifest, type PlatformManifest } from './plugin-platform-manifest';
import { platformCallPolicy } from '../../src/extensions/platform/platform-call-policy';

const manifest = (): PlatformManifest => ({
  packageFormat: 'boaa.extension.package',
  packageVersion: 3,
  apiVersion: 2,
  extension: { id: 'org.example.discovery', name: 'Discovery', version: '1.0.0' },
  license: 'MIT',
  entries: {
    controller: { path: 'dist/controller.js', permissions: ['home.feed'] },
    ui: { path: 'dist/ui.js', permissions: ['ui.render', 'app.search'] },
  },
  activation: ['onHome', 'onView'],
  features: { required: ['home.feed', 'ui.views', 'app.search'], optional: [] },
  contributes: {
    commands: [],
    views: ['explore'],
    decorations: [],
    homeSections: [{ id: 'popular', title: 'Popular', view: 'explore' }],
  },
  requestedAccess: { storageKiB: 0, contentScopes: [] },
});
it('links a home action only to a declared view', () => {
  expect(validatePlatformManifest(manifest()).ok).toBe(true);
  const bad = manifest();
  bad.contributes.homeSections![0].view = 'unknown';
  expect(validatePlatformManifest(bad)).toMatchObject({ ok: false, path: 'homeSections.view' });
  for (const view of ['', '../explore', 'https://example.test/']) {
    bad.contributes.homeSections![0].view = view;
    expect(validatePlatformManifest(bad).ok).toBe(false);
  }
});
it('requires explicit UI-only search permission and feature negotiation', () => {
  expect(platformCallPolicy('app.search')).toEqual({ roles: ['ui'], permission: 'app.search' });
  const missing = manifest();
  missing.features.required = missing.features.required.filter((x) => x !== 'app.search');
  expect(validatePlatformManifest(missing)).toMatchObject({ ok: false, path: 'features.required' });
  for (const role of ['controller', 'task'] as const) {
    const bad = manifest();
    bad.entries[role] = {
      path: `dist/${role}.js`,
      permissions: ['app.search', ...(role === 'controller' ? ['home.feed' as const] : [])],
    };
    expect(validatePlatformManifest(bad)).toMatchObject({ ok: false, path: 'permissions.roles' });
  }
});
