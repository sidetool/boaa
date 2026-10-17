import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { PlatformRuntimeInfo } from '../../platform/runtime';

export function useApplicationInfoSettingsModel(platformRuntime: PlatformRuntimeInfo) {
  const appRuntime = useOptionalAppRuntime();
  const product = appRuntime?.product;
  const reader = appRuntime?.readerRuntime;
  const webAccessUrl =
    platformRuntime.kind === 'browser' && reader?.mode === 'remote'
      ? new URL((reader.apiBaseUrl ?? '/api').replace(/\/api\/?$/, '/') || '/', window.location.href).href
      : undefined;
  const isAndroid = platformRuntime.kind === 'tauri-mobile' && /Android/i.test(platformRuntime.userAgent);
  const mediaSessionAvailable =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator && Boolean(navigator.mediaSession);
  return { productAvailable: Boolean(product), reader, webAccessUrl, isAndroid, mediaSessionAvailable };
}
export type ApplicationInfoSettingsModel = ReturnType<typeof useApplicationInfoSettingsModel>;
