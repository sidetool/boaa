import type { UiJson } from '@boaa/extension-contracts/ui-json';
import type { PlatformPluginStore } from './plugin-store';
import type { PluginSession } from './store-model';
import type { StorageGet, StorageList, StorageRemove, StorageSet } from './store-kv';

/** Each store method validates its full input and durable grant inside its transaction. */
export async function storageCall(
  store: PlatformPluginStore,
  session: PluginSession,
  method: string,
  input: UiJson,
): Promise<UiJson> {
  if (method === 'storage.get')
    return (await store.storageGet(session, input as unknown as StorageGet)) as unknown as UiJson;
  if (method === 'storage.set') return store.storageSet(session, input as unknown as StorageSet);
  if (method === 'storage.remove') return store.storageRemove(session, input as unknown as StorageRemove);
  if (method === 'storage.list') return store.storageList(session, input as unknown as StorageList);
  throw Error('METHOD_NOT_ALLOWED');
}
