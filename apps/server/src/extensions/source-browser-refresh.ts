import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';
import type { SourceCredentialVault } from './source-credential-vault.js';

interface Refresh {
  promise: Promise<void>;
  controller: AbortController;
  waiters: number;
}
const identities = new WeakMap<SourceCredentialVault, number>();
let sequence = 0;
const refreshing = new Map<string, Refresh>();

/** One bounded refresh per source/vault/origin/proxy. Cancelling one caller does not cancel the others. */
export async function refreshSourceBrowserSession(
  url: string,
  headers: Record<string, string> | undefined,
  scope: SourceWebViewScope,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let owner = 0;
  if (scope.vault) {
    owner = identities.get(scope.vault) ?? ++sequence;
    identities.set(scope.vault, owner);
  }
  const key = JSON.stringify([owner, scope.key, new URL(url).origin, scope.outboundProxy ?? '']);
  let entry = refreshing.get(key);
  if (!entry) {
    if (refreshing.size >= 64) throw new Error('execution_busy');
    const controller = new AbortController();
    const created: Refresh = { controller, waiters: 0, promise: Promise.resolve() };
    created.promise = sourceWebViewHost
      .evaluate({ url, headers, script: 'null', timeoutMs: 30000 }, scope, controller.signal)
      .then(() => undefined)
      .finally(() => {
        if (refreshing.get(key) === created) refreshing.delete(key);
      });
    entry = created;
    refreshing.set(key, entry);
  }
  entry.waiters++;
  let abort = () => {};
  try {
    await Promise.race([
      entry.promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
    if (--entry.waiters === 0) {
      entry.controller.abort();
      if (refreshing.get(key) === entry) refreshing.delete(key);
    }
  }
}
