import {
  isBrandValue,
  legacyBrandNames,
  readBrandStorage,
  removeBrandStorage,
  writeBrandStorage,
} from '@boaa/extension-contracts/brand-compat';
import { exchangeDropboxAuthorizationCode, type DropboxCredential } from './dropbox-provider';

const CALLBACK_TYPE = 'boaa-dropbox-oauth-callback';
const CALLBACK_CHANNEL = 'boaa-dropbox-oauth-callback-channel';
const POPUP_NAME = 'boaa-dropbox-oauth';
const REDIRECT_PENDING_KEY = 'boaa.dropbox.oauth.redirect.v1';
const REDIRECT_PENDING_MAX_AGE_MS = 10 * 60 * 1_000;
export const DESKTOP_DROPBOX_REDIRECT_URI = 'http://127.0.0.1:53682/oauth/dropbox';
let redirectCompletionPromise: Promise<DropboxCredential | undefined> | undefined;

export interface DropboxOAuthCallbackMessage {
  readonly type: typeof CALLBACK_TYPE;
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
}

interface PendingDropboxRedirectV1 {
  readonly version: 1;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

async function prepareDropboxAuthorization(input: {
  readonly appKey: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly allowDesktopRedirect?: boolean;
}): Promise<{ authorizeUrl: string; state: string; verifier: string; redirectUri: string }> {
  const redirectUri = input.redirectUri ?? defaultDropboxRedirectUri();
  if (!redirectUri) throw new Error('Dropbox OAuth currently requires an HTTP or HTTPS web origin.');
  const parsedRedirectUri = new URL(redirectUri);
  const currentLocation = globalThis.location;
  const currentOriginRedirect =
    Boolean(currentLocation) &&
    ['http:', 'https:'].includes(parsedRedirectUri.protocol) &&
    parsedRedirectUri.origin === currentLocation.origin;
  const desktopRedirect = input.allowDesktopRedirect && redirectUri === DESKTOP_DROPBOX_REDIRECT_URI;
  if (!currentOriginRedirect && !desktopRedirect) {
    throw new Error('Dropbox OAuth redirect must use the current web origin.');
  }
  const verifier = randomValue(48);
  const state = randomValue(24);
  const authorize = new URL('https://www.dropbox.com/oauth2/authorize');
  authorize.searchParams.set('client_id', input.appKey);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('token_access_type', 'offline');
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', await codeChallenge(verifier));
  authorize.searchParams.set('state', state);
  const scopes = [...new Set(input.scopes?.map((scope) => scope.trim()).filter(Boolean) ?? [])];
  if (scopes.some((scope) => !/^[a-z0-9._:-]+$/i.test(scope))) {
    throw new Error('Dropbox OAuth scope is invalid.');
  }
  if (scopes.length > 0) authorize.searchParams.set('scope', scopes.join(' '));
  return { authorizeUrl: authorize.toString(), state, verifier, redirectUri };
}

interface DesktopDropboxOAuthCallback {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly accountId: string;
}

/** Uses the operating-system browser and a fixed loopback callback in packaged desktop builds. */
export async function connectDropboxWithDesktopBrowser(input: {
  readonly appKey: string;
  readonly scopes?: readonly string[];
  readonly fetchImpl?: typeof fetch;
}): Promise<DropboxCredential> {
  const prepared = await prepareDropboxAuthorization({
    ...input,
    redirectUri: DESKTOP_DROPBOX_REDIRECT_URI,
    allowDesktopRedirect: true,
  });
  const { invoke } = await import('@tauri-apps/api/core');
  const credential = await invoke<DesktopDropboxOAuthCallback>('desktop_dropbox_oauth_authorize', {
    authorizeUrl: prepared.authorizeUrl,
    expectedState: prepared.state,
    codeVerifier: prepared.verifier,
  });
  if (!credential.accessToken || !credential.accountId) {
    throw new Error('Dropbox authorization did not return an account.');
  }
  if (
    credential.expiresIn !== undefined &&
    (!Number.isSafeInteger(credential.expiresIn) || credential.expiresIn <= 0 || credential.expiresIn > 31_536_000)
  ) {
    throw new Error('Dropbox token expiry is invalid.');
  }
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt:
      credential.expiresIn === undefined
        ? undefined
        : new Date(Date.now() + credential.expiresIn * 1_000).toISOString(),
    accountId: credential.accountId,
  };
}

function cleanDropboxCallbackQuery(): void {
  const url = new URL(globalThis.location.href);
  ['code', 'state', 'error', 'error_description'].forEach((key) => url.searchParams.delete(key));
  globalThis.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function defaultDropboxRedirectUri(): string | undefined {
  if (!globalThis.location || !['http:', 'https:'].includes(globalThis.location.protocol)) return undefined;
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

export function relayDropboxOAuthPopup(): boolean {
  if (!globalThis.location || (!globalThis.window?.opener && !isBrandValue(globalThis.window?.name, POPUP_NAME))) {
    return false;
  }
  const query = new URLSearchParams(globalThis.location.search);
  const code = query.get('code') ?? undefined;
  const state = query.get('state') ?? undefined;
  const error = query.get('error') ?? undefined;
  if (!state || (!code && !error)) return false;
  const message: DropboxOAuthCallbackMessage = {
    type: CALLBACK_TYPE,
    code,
    state,
    error,
  };
  globalThis.window.opener?.postMessage(
    {
      ...message,
      type: isBrandValue(globalThis.window.name, POPUP_NAME) ? globalThis.window.name + '-callback' : CALLBACK_TYPE,
    },
    globalThis.location.origin,
  );
  if (typeof globalThis.BroadcastChannel === 'function') {
    for (const name of [CALLBACK_CHANNEL, ...legacyBrandNames(CALLBACK_CHANNEL)]) {
      const channel = new globalThis.BroadcastChannel(name);
      channel.postMessage({ ...message, type: name.replace('-channel', '') });
      channel.close();
    }
  }
  globalThis.window.close();
  return true;
}

export async function connectDropboxWithPopup(input: {
  readonly appKey: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly fetchImpl?: typeof fetch;
}): Promise<DropboxCredential> {
  const { authorizeUrl, redirectUri, state, verifier } = await prepareDropboxAuthorization(input);

  const callbackChannels =
    typeof globalThis.BroadcastChannel === 'function'
      ? [CALLBACK_CHANNEL, ...legacyBrandNames(CALLBACK_CHANNEL)].map((name) => new globalThis.BroadcastChannel(name))
      : [];
  const popup = globalThis.window.open(authorizeUrl, POPUP_NAME, 'popup,width=560,height=720,noopener=false');
  if (!popup) {
    callbackChannels.forEach((channel) => channel.close());
    throw new Error('Dropbox sign-in popup was blocked. Allow popups and try again.');
  }

  const callback = await new Promise<DropboxOAuthCallbackMessage>((resolve, reject) => {
    let finished = false;
    const timeout = globalThis.setTimeout(() => finish(new Error('Dropbox sign-in timed out.')), 120_000);
    const closed = globalThis.setInterval(() => {
      try {
        if (popup.closed) finish(new Error('Dropbox sign-in was cancelled.'));
      } catch {
        // Cross-origin isolation may temporarily hide popup state; the callback channel remains authoritative.
      }
    }, 400);
    const acceptCallback = (value: DropboxOAuthCallbackMessage) => {
      if (value.state !== state) {
        finish(new Error('Dropbox OAuth state did not match.'));
        return;
      }
      finish(undefined, value);
    };
    const onMessage = (event: MessageEvent<DropboxOAuthCallbackMessage>) => {
      if (
        event.source !== popup ||
        event.origin !== globalThis.location.origin ||
        !isBrandValue(event.data?.type, CALLBACK_TYPE)
      ) {
        return;
      }
      acceptCallback(event.data);
    };
    for (const callbackChannel of callbackChannels) {
      callbackChannel.onmessage = (event: MessageEvent<DropboxOAuthCallbackMessage>) => {
        if (isBrandValue(event.data?.type, CALLBACK_TYPE)) acceptCallback(event.data);
      };
    }
    const finish = (error?: Error, value?: DropboxOAuthCallbackMessage) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(closed);
      globalThis.removeEventListener('message', onMessage);
      callbackChannels.forEach((channel) => channel.close());
      if (!popup.closed) popup.close();
      if (error) reject(error);
      else resolve(value!);
    };
    globalThis.addEventListener('message', onMessage);
  });
  if (callback.error || !callback.code) {
    throw new Error('Dropbox authorization failed or was cancelled.');
  }
  return exchangeDropboxAuthorizationCode({
    appKey: input.appKey,
    code: callback.code,
    codeVerifier: verifier,
    redirectUri,
    fetchImpl: input.fetchImpl,
  });
}

/** Starts an OAuth flow in the current tab for runtimes that do not expose popup windows. */
export async function beginDropboxAuthorizationRedirect(input: {
  readonly appKey: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
}): Promise<void> {
  const prepared = await prepareDropboxAuthorization(input);
  const pending: PendingDropboxRedirectV1 = {
    version: 1,
    state: prepared.state,
    verifier: prepared.verifier,
    redirectUri: prepared.redirectUri,
    createdAt: Date.now(),
  };
  try {
    writeBrandStorage(globalThis.sessionStorage, REDIRECT_PENDING_KEY, JSON.stringify(pending));
  } catch {
    throw new Error('Dropbox 연결 상태를 이 탭에 임시 저장할 수 없습니다.');
  }
  globalThis.location.assign(prepared.authorizeUrl);
}

/** Completes a current-tab OAuth redirect once, then removes code/state from the visible URL. */
export function completeDropboxAuthorizationRedirect(input: {
  readonly appKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DropboxCredential | undefined> {
  const query = new URLSearchParams(globalThis.location.search);
  const state = query.get('state');
  const code = query.get('code');
  const error = query.get('error');
  if (!state || (!code && !error)) return Promise.resolve(undefined);
  if (redirectCompletionPromise) return redirectCompletionPromise;
  redirectCompletionPromise = completeDropboxAuthorizationRedirectOnce(input, { state, code, error });
  return redirectCompletionPromise;
}

async function completeDropboxAuthorizationRedirectOnce(
  input: { readonly appKey: string; readonly fetchImpl?: typeof fetch },
  callback: { readonly state: string; readonly code: string | null; readonly error: string | null },
): Promise<DropboxCredential> {
  let pending: Partial<PendingDropboxRedirectV1> | undefined;
  try {
    const raw = readBrandStorage(globalThis.sessionStorage, REDIRECT_PENDING_KEY);
    pending = raw ? (JSON.parse(raw) as Partial<PendingDropboxRedirectV1>) : undefined;
    removeBrandStorage(globalThis.sessionStorage, REDIRECT_PENDING_KEY);
  } catch {
    cleanDropboxCallbackQuery();
    throw new Error('저장된 Dropbox 연결 상태를 읽을 수 없습니다. 다시 연결해 주세요.');
  }

  try {
    if (
      pending?.version !== 1 ||
      pending.state !== callback.state ||
      typeof pending.verifier !== 'string' ||
      typeof pending.redirectUri !== 'string' ||
      typeof pending.createdAt !== 'number' ||
      Date.now() - pending.createdAt > REDIRECT_PENDING_MAX_AGE_MS
    ) {
      throw new Error('Dropbox 연결 요청이 만료됐거나 현재 탭의 요청과 일치하지 않습니다. 다시 연결해 주세요.');
    }
    if (callback.error || !callback.code) throw new Error('Dropbox 연결이 취소됐거나 승인되지 않았습니다.');
    return await exchangeDropboxAuthorizationCode({
      appKey: input.appKey,
      code: callback.code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      fetchImpl: input.fetchImpl,
    });
  } finally {
    cleanDropboxCallbackQuery();
  }
}
