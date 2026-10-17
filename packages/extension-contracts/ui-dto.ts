import type { UiJson } from './ui-json';
import type { UiFeature } from './ui-package-manifest';

/** Public opaque locator; no internal Reader/React/state types cross this boundary. */
export interface PluginLocation {
  schemaVersion: 1;
  bookId: string;
  documentRevision: string;
  locator: string;
}
export interface SharedSelection {
  schemaVersion: 1;
  text: string;
  location: PluginLocation;
  capturedAt: string;
  textSource: 'original' | 'ocr';
}
export interface UiMethodMap {
  'runtime.getCapabilities': {
    params: Record<string, never>;
    result: { apiVersion: 1; apiMinor: 0; features: UiFeature[] };
  };
  'commands.register': { params: { commandId: string; handlerId: string }; result: { registrationId: string } };
  'commands.unregister': { params: { registrationId: string }; result: null };
  'reader.consumeSelection': { params: { token: string }; result: SharedSelection };
  'storage.get': {
    params: { key: string };
    result: { found: false } | { found: true; value: UiJson; revision: number };
  };
  'storage.set': {
    params: { key: string; value: UiJson; expectedRevision: number | null; idempotencyKey: string };
    result: { revision: number; receiptId: string };
  };
  'storage.remove': {
    params: { key: string; expectedRevision: number; idempotencyKey: string };
    result: { revision: number; receiptId: string };
  };
  'storage.list': {
    params: { prefix?: string; limit: number; cursor?: string };
    result: { items: { key: string; value: UiJson; revision: number }[]; nextCursor?: string };
  };
}
export type UiMethod = keyof UiMethodMap;
export type UiRequest<M extends UiMethod = UiMethod> = M extends UiMethod
  ? {
      wireVersion: 1;
      kind: 'request';
      sessionId: string;
      requestId: string;
      method: M;
      params: UiMethodMap[M]['params'];
    }
  : never;
export const UI_ERROR_CODES = [
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'CONTEXT_STALE',
  'PACKAGE_GENERATION_CHANGED',
  'STORAGE_CONFLICT',
  'QUOTA_EXCEEDED',
  'CANCELLED',
  'TIMEOUT',
  'PLUGIN_STOPPED',
  'INTERNAL_ERROR',
] as const;
export type UiResponse<M extends UiMethod = UiMethod> = {
  wireVersion: 1;
  kind: 'response';
  sessionId: string;
  requestId: string;
} & (
  | { ok: true; result: UiMethodMap[M]['result'] }
  | { ok: false; error: { code: (typeof UI_ERROR_CODES)[number]; retryable: boolean } }
);
export interface UiCommandInvocation {
  wireVersion: 1;
  kind: 'invoke';
  sessionId: string;
  requestId: string;
  handlerId: string;
  invocationId: string;
  selectionToken?: string;
}
export interface UiCommandResult {
  wireVersion: 1;
  kind: 'invocationResult';
  sessionId: string;
  requestId: string;
  ok: boolean;
}
export interface UiCancel {
  wireVersion: 1;
  kind: 'cancel';
  sessionId: string;
  requestId: string;
}
export interface UiContextEvent {
  wireVersion: 1;
  kind: 'event';
  sessionId: string;
  eventId: string;
  sequence: number;
  event: 'ui.contextChanged';
  payload: { theme: 'light' | 'dark'; locale: string; panelId: string };
}
