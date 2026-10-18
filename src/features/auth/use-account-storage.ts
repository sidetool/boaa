import { useMemo } from 'react';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { accountStorage } from '../../storage/account-storage';
function unavailableStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
export function useAccountStorage(): Storage {
  const session = useOptionalAppRuntime()?.readerRuntime.session;
  return useMemo(() => {
    let storage: Storage;
    try {
      storage = globalThis.localStorage ?? unavailableStorage();
    } catch {
      storage = unavailableStorage();
    }
    return session ? accountStorage(storage, session.storageScope, session.signal) : storage;
  }, [session]);
}
