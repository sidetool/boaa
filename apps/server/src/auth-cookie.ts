import type { FastifyRequest } from 'fastify';

export const SELF_HOST_SESSION_COOKIE = 'boaa_session';
const LEGACY_SESSION_COOKIE = 'moya_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function requestCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const candidate of name === SELF_HOST_SESSION_COOKIE ? [name, LEGACY_SESSION_COOKIE] : [name])
    for (const entry of header.split(';')) {
      const separator = entry.indexOf('=');
      if (separator < 0 || entry.slice(0, separator).trim() !== candidate) continue;
      const value = entry.slice(separator + 1).trim();
      if (!value) return undefined;
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  return undefined;
}

function requestUsesHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',', 1)[0]?.trim().toLowerCase();
  return protocol === 'https' || request.protocol === 'https';
}

export function selfHostSessionCookie(
  request: FastifyRequest,
  token: string,
  maxAgeSeconds: number,
  forceSecure = false,
  name = SELF_HOST_SESSION_COOKIE,
): string {
  return [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(forceSecure || requestUsesHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSelfHostSessionCookie(request: FastifyRequest, forceSecure = false): string {
  return selfHostSessionCookie(request, '', 0, forceSecure);
}

/** Call only after the server has authenticated the session token. */
export function migratedSessionCookies(request: FastifyRequest, forceSecure = false): string[] | undefined {
  const hasCanonical = request.headers.cookie
    ?.split(';')
    .some((entry) => entry.split('=', 1)[0].trim() === SELF_HOST_SESSION_COOKIE);
  if (hasCanonical) return undefined;
  const token = requestCookie(request, SELF_HOST_SESSION_COOKIE);
  return token
    ? [
        selfHostSessionCookie(request, token, SESSION_MAX_AGE_SECONDS, forceSecure),
        selfHostSessionCookie(request, '', 0, forceSecure, LEGACY_SESSION_COOKIE),
      ]
    : undefined;
}
export function clearedSessionCookies(request: FastifyRequest, forceSecure = false): string[] {
  return [
    clearedSelfHostSessionCookie(request, forceSecure),
    selfHostSessionCookie(request, '', 0, forceSecure, LEGACY_SESSION_COOKIE),
  ];
}
