import { IDBFactory } from 'fake-indexeddb';
import type { EntryRole, PlatformPermission } from '@boaa/extension-contracts/platform-package';
import { buildPlatformPackage } from '../packages/platform-package';
import { inspectSingleJs } from '../packages/platform-single-js';
import { PlatformPluginStore } from './plugin-store';
import type { InstallApproval, InstallReview } from './store-model';
import type { SettingsSchema } from './settings-schema';
export const id = 'org.example.passive';
export const scope = {
  kind: 'remote' as const,
  profileId: 'profile',
  serverId: 'server',
  accountId: 'alice',
  libraryId: 'library',
};
export const schema: SettingsSchema = {
  version: 1,
  fields: { color: { type: 'color', default: '#123456' }, enabled: { type: 'boolean', default: true } },
};
export function single(version = '1.0.0', comment = '') {
  return new Blob([
    `/* @boaa-plugin ${JSON.stringify({ id, version, apiVersion: 2, license: 'MIT', activation: ['onReader'], permissions: ['settings.own'], features: ['settings.schema'], contributes: {} })} */\nthrow Error('Never run in storage');\n${comment}`,
  ]);
}
export async function composite(signingKey?: CryptoKeyPair, version = '1.0.0') {
  const blob = single(version);
  const manifest = inspectSingleJs(new Uint8Array(await blob.arrayBuffer())).manifest;
  manifest.entries.ui = { path: 'dist/ui.js', permissions: ['ui.render'] };
  manifest.entries.task = { path: 'dist/task.js', permissions: [] };
  manifest.features.required.push('ui.views');
  manifest.contributes.views.push('settings');
  return buildPlatformPackage({
    manifest,
    sources: { controller: await blob.text(), ui: '// ui', task: '// task' },
    license: 'MIT',
    signingKey,
  });
}
export function approve(review: InstallReview, options: Partial<InstallApproval> = {}): InstallApproval {
  const roles: Partial<Record<EntryRole, PlatformPermission[]>> = {};
  for (const role of ['controller', 'ui', 'task'] as const)
    if (review.manifest.entries[role]) roles[role] = review.manifest.entries[role]!.permissions;
  return { digest: review.digest, roles, enabled: true, data: 'reset', ...options };
}
export function setup(now?: () => number) {
  const factory = new IDBFactory(),
    name = crypto.randomUUID();
  const options = { factory, name, now };
  return {
    factory,
    name,
    store: new PlatformPluginStore(scope, options),
    peer: new PlatformPluginStore(scope, options),
  };
}
export async function install(store: PlatformPluginStore) {
  const review = await store.inspect(single(), 'single-js', 'file:plugin');
  return store.install(review, approve(review));
}
