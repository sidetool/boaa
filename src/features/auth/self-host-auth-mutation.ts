/** Cookie issuance and revocation share one browser-profile lock per server origin.
 * Broadcast messages cannot order HTTP Set-Cookie responses across tabs.
 */
export async function withSelfHostAuthMutation<T>(
  baseUrl: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const origin = new URL(baseUrl, globalThis.location?.origin ?? 'http://localhost').origin;
  const run = () => {
    signal?.throwIfAborted();
    return operation();
  };
  if (globalThis.navigator?.locks) {
    return await navigator.locks.request(
      `boaa:auth-cookie:${origin}`,
      { mode: 'exclusive', ...(signal ? { signal } : {}) },
      run,
    );
  }
  // The hosted browser requires secure-context Web Locks. Non-browser unit clients
  // have no shared cookie jar and retain their existing request behavior.
  if (typeof window !== 'undefined')
    return Promise.reject(new Error('Account switching requires a browser with Web Locks over HTTPS.'));
  return run();
}
