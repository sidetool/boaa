import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';
import type { SourceCredentialVault } from './source-credential-vault.js';

interface Refresh {
  promise: Promise<void>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  expires: number;
}
const identities = new WeakMap<SourceCredentialVault, number>();
let sequence = 0;
const refreshing = new Map<string, Refresh>();
const recent = new Map<string, Refresh>();
const cooldownMs = 60_000;

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
  for (const [id, result] of recent) if (result.expires <= Date.now()) recent.delete(id);
  let entry = refreshing.get(key);
  // Clearance is not transferable on every server. Do not cold-launch for every
  // chapter/cover after an unsuccessful attempt, or for a late concurrent 403.
  entry ??= recent.get(key);
  if (!entry) {
    if (refreshing.size >= 64) throw new Error('execution_busy');
    const controller = new AbortController();
    const created: Refresh = { controller, waiters: 0, promise: Promise.resolve(), settled: false, expires: 0 };
    created.promise = sourceWebViewHost
      .evaluate(
        { url, headers, script: 'null', timeoutMs: 30000 },
        { ...scope, authenticationOnly: true },
        controller.signal,
      )
      .then(() => undefined)
      .finally(() => {
        created.settled = true;
        if (refreshing.get(key) === created) refreshing.delete(key);
        if (!controller.signal.aborted) {
          created.expires = Date.now() + cooldownMs;
          recent.set(key, created);
          while (recent.size > 64) recent.delete(recent.keys().next().value!);
        }
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
    if (--entry.waiters === 0 && !entry.settled) {
      entry.controller.abort();
      if (refreshing.get(key) === entry) refreshing.delete(key);
    }
  }
}
