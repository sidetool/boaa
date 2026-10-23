/** Host-only account persistence protocol. Never exposed to plugin guests. */
export const PLUGIN_STATE_STORES = [
  'installations',
  'archives',
  'grants',
  'config',
  'kv',
  'usage',
  'preferences',
] as const;
export type PluginStateStore = (typeof PLUGIN_STATE_STORES)[number];
export type PluginStateKey = string | string[];
export interface PluginStateChange {
  store: PluginStateStore;
  key: PluginStateKey;
  /** Omitted for deletion. Archives use blobBase64 instead of Blob/ArrayBuffer. */
  value?: Record<string, unknown>;
}
export interface PluginStateDelta {
  revision: number;
  changes: PluginStateChange[];
  reset?: boolean;
}
export const PLUGIN_STATE_LIMITS = {
  patchBytes: 16 * 1024 * 1024,
  changes: 4096,
  rows: 20000,
  archiveBytes: 128 * 1024 * 1024,
  kvBytes: 32 * 1024 * 1024,
  kvEntries: 128,
  configBytes: 8 * 1024 * 1024,
} as const;
export const PLUGIN_STATE_KEYS: Record<PluginStateStore | 'runtime-markers', readonly string[]> = {
  installations: ['scope', 'pluginId'],
  archives: ['scope', 'pluginId', 'digest'],
  grants: ['scope', 'pluginId'],
  config: ['scope', 'installationId'],
  kv: ['scope', 'installationId', 'key'],
  usage: ['id'],
  preferences: ['scope', 'key'],
  'runtime-markers': ['scope', 'installationId', 'instanceId'],
};
export function pluginStateKey(store: keyof typeof PLUGIN_STATE_KEYS, row: Record<string, unknown>): PluginStateKey {
  const parts = PLUGIN_STATE_KEYS[store].map((field) => row[field]);
  if (parts.some((part) => typeof part !== 'string')) throw Error('INVALID_STATE_ROW');
  return store === 'usage' ? (parts[0] as string) : (parts as string[]);
}
