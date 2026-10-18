/** An immutable account-owned view. Brand aliases remain inside the same namespace. */
export function accountStorage(storage: Storage, scope: string, signal?: AbortSignal): Storage {
  const prefix = `boaa.account:${encodeURIComponent(scope)}:`;
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (key): key is string => key !== null && key.startsWith(prefix),
    );
  return {
    get length() {
      signal?.throwIfAborted();
      return keys().length;
    },
    key(index) {
      signal?.throwIfAborted();
      return keys()[index]?.slice(prefix.length) ?? null;
    },
    getItem(key) {
      signal?.throwIfAborted();
      return storage.getItem(prefix + key);
    },
    setItem(key, value) {
      signal?.throwIfAborted();
      storage.setItem(prefix + key, value);
    },
    removeItem(key) {
      signal?.throwIfAborted();
      storage.removeItem(prefix + key);
    },
    clear() {
      signal?.throwIfAborted();
      keys().forEach((key) => storage.removeItem(key));
    },
  };
}
