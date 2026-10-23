import { isUiJson, uiInteger, uiKeys, uiRecord, uiString, uiUtf8Size, type UiJson } from './ui-json';

/** Disposable server data. These budgets never consume or evict permanent storage. */
export const PLUGIN_CACHE_LIMITS = {
  entryBytes: 48 * 1024,
  pluginBytes: 256 * 1024,
  pluginEntries: 64,
  accountBytes: 8 * 1024 * 1024,
  imagePluginBytes: 8 * 1024 * 1024,
  imagePluginEntries: 128,
  imageAccountBytes: 64 * 1024 * 1024,
} as const;
export type PluginCacheResult =
  { found: false } | { found: true; value: UiJson; savedAt: number; freshUntil: number; expiresAt: number };
export interface PluginCacheRequest {
  action: 'get' | 'set' | 'remove';
  key: string;
  value?: UiJson;
  ttlSeconds?: number;
  staleSeconds?: number;
}
export function pluginCacheRequest(input: unknown): input is PluginCacheRequest {
  return (
    uiRecord(input) &&
    uiString(input.key, 512) &&
    (input.action === 'set'
      ? uiKeys(input, ['action', 'key', 'value', 'ttlSeconds', 'staleSeconds']) &&
        isUiJson(input.value, PLUGIN_CACHE_LIMITS.entryBytes) &&
        isUiJson(
          { reply: { result: { ok: true, value: { found: true, value: input.value, times: [0, 0, 0] } } } },
          65536,
        ) &&
        uiUtf8Size(JSON.stringify(input.value)) + uiUtf8Size(input.key) <= PLUGIN_CACHE_LIMITS.entryBytes &&
        uiInteger(input.ttlSeconds, 60, 86400) &&
        uiInteger(input.staleSeconds, 0, 604800)
      : ['get', 'remove'].includes(String(input.action)) && uiKeys(input, ['action', 'key']))
  );
}
