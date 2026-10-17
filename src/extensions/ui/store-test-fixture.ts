import { IDBFactory } from 'fake-indexeddb';
import type { UiPermission } from '@boaa/extension-contracts/ui-package';
import { uiManifestFixture } from '../../../packages/extension-contracts/ui-test-fixture';
import { buildBrowserUiPackage } from '../packages/browser-ui-package';
import { UiPluginStore, type InstallApproval, type InstallReview } from './plugin-store';
export const scope = { kind: 'local' as const, profileId: 'profile', libraryId: 'library' };
export const id = 'org.example.wordbook';
export const permissionList: UiPermission[] = [
  'ui.panel.render',
  'commands.register',
  'reader.selection.consume',
  'storage.own',
];
export async function packageFixture(
  version = '1.0.0',
  options: { key?: CryptoKeyPair; storageKiB?: number; code?: string } = {},
) {
  const manifest = uiManifestFixture();
  manifest.extension.version = version;
  manifest.requestedAccess.storageKiB = options.storageKiB ?? 1024;
  return buildBrowserUiPackage({
    manifest,
    source: options.code ?? 'throw Error("never execute UI during install");',
    license: 'MIT',
    signingKey: options.key,
  });
}
export const approve = (review: InstallReview, extra: Partial<InstallApproval> = {}): InstallApproval => ({
  digest: review.digest,
  permissions: permissionList,
  enabled: true,
  data: 'reset',
  ...extra,
});
export const preserve = { data: 'preserve' as const, allowUnsignedDataReuse: true };
export function setup() {
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  let time = 1800000000000;
  const store = new UiPluginStore(scope, { factory, name, now: () => time });
  const peer = new UiPluginStore(scope, { factory, name, now: () => time });
  return {
    store,
    peer,
    factory,
    name,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
export async function install(store: UiPluginStore, archive?: Blob, source = 'local-file:fixture') {
  const review = await store.inspect(archive ?? (await packageFixture()), source);
  return store.install(review, approve(review));
}
