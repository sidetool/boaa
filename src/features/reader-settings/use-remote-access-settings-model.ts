import { useContext } from 'react';
import { EmbeddedAccessContext } from '../../platform/embedded-access-context';

export function remoteAccessAddress(serverApiBaseUrl?: string, locationHref?: string) {
  let address: URL | undefined;
  if (serverApiBaseUrl) {
    try {
      address = new URL(serverApiBaseUrl, locationHref);
      address.pathname = address.pathname.replace(/\/api\/?$/, '/') || '/';
      address.search = '';
      address.hash = '';
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) address = undefined;
    } catch {
      /* No shareable address for a local-only library. */
    }
  }
  const loopback = address && /^(localhost|127(?:\.\d+){3}|\[::1\])$/i.test(address.hostname);
  return { address, loopback: Boolean(loopback) };
}
export function useRemoteAccessSettingsModel(serverApiBaseUrl?: string) {
  const embedded = useContext(EmbeddedAccessContext);
  return {
    embedded,
    ...remoteAccessAddress(
      embedded ? undefined : serverApiBaseUrl,
      typeof window === 'undefined' ? undefined : window.location?.href,
    ),
  };
}
export type RemoteAccessSettingsModel = ReturnType<typeof useRemoteAccessSettingsModel>;
