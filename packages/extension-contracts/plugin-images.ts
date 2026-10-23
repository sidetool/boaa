import { isUiJson, uiKeys, uiRecord } from './ui-json';
import { pluginHttpRequest } from './plugin-http';
export const PLUGIN_IMAGE_BYTES = 512 * 1024;
export const PLUGIN_IMAGE_REPLY_BYTES = 704 * 1024;
export const PLUGIN_IMAGE_WIDTH = 320;
export const PLUGIN_IMAGE_HEIGHT = 480;
export interface PluginImageInput {
  slot: string;
  path: string;
}
export interface PluginImageRequest extends PluginImageInput {
  cachedRevision?: string;
}
export function pluginImageRequest(value: unknown): value is PluginImageRequest {
  return (
    isUiJson(value, 4096) &&
    uiRecord(value) &&
    uiKeys(value, ['slot', 'path'], ['cachedRevision']) &&
    pluginHttpRequest({ slot: value.slot, path: value.path, method: 'GET', response: 'text' }) &&
    (value.cachedRevision === undefined ||
      (typeof value.cachedRevision === 'string' && /^[a-f0-9-]{36}$/i.test(value.cachedRevision)))
  );
}
