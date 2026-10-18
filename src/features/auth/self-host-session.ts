import { withSelfHostAuthMutation } from './self-host-auth-mutation';
import { SELF_HOST_AUTH_REQUIRED_EVENT } from '../../services/remote/self-host-auth-events';

import type { SelfHostAuthenticatedContext } from '@boaa/contracts';
export type { SelfHostAuthenticatedContext } from '@boaa/contracts';

/** Immutable ownership, captured by every request; never resolves a mutable current user. */
export class SelfHostSession {
  readonly epoch = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly storageScope: string;
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  constructor(
    readonly context: SelfHostAuthenticatedContext,
    readonly apiBaseUrl: string,
  ) {
    this.storageScope = `hosted-account:${encodeURIComponent(
      JSON.stringify([
        new URL(apiBaseUrl, globalThis.location?.origin ?? 'http://localhost').href,
        context.serverId,
        context.account.userId,
        context.libraryId,
      ]),
    )}`;
  }
  dispose(): void {
    this.controller.abort();
  }
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    this.signal.throwIfAborted();
    const base = new URL(this.apiBaseUrl.replace(/\/$/, '') + '/', globalThis.location?.origin ?? 'http://localhost');
    const target = new URL(input instanceof Request ? input.url : String(input), base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      throw new Error('Session request left its server API');
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('Authorization');
    headers.set('X-BOAA-Session-Context', this.context.sessionContext);
    const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.signal]) : this.signal;
    const send = () => {
      signal.throwIfAborted();
      return fetch(input instanceof Request ? input : target.href, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers,
        // Cookie responses must finish under the cross-tab lock even if the old runtime closes.
        signal: cookieMutation ? new AbortController().signal : signal,
      });
    };
    const cookieMutation =
      /\/auth\/(password|logout|logout-all)$/.test(target.pathname) &&
      (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET';
    const response = cookieMutation ? await withSelfHostAuthMutation(target.href, send, signal) : await send();
    this.signal.throwIfAborted();
    let mismatch = false;
    if (response.status === 409) {
      const body = await response
        .clone()
        .json()
        .catch(() => ({}));
      mismatch = body.error === 'session_context_mismatch';
    }
    if (response.status === 401 || mismatch) {
      globalThis.dispatchEvent?.(new CustomEvent(SELF_HOST_AUTH_REQUIRED_EVENT, { detail: { epoch: this.epoch } }));
      this.dispose();
      throw new DOMException('Account session ended', 'AbortError');
    }
    return response;
  }
}
