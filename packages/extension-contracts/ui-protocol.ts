import { isUiJson, UI_LIMITS, uiId, uiInteger, uiKeys, uiRecord, uiString, uiUtf8Size } from './ui-json';
import { UI_FEATURES } from './ui-package-manifest';
import {
  UI_ERROR_CODES,
  type UiMethod,
  type UiRequest,
  type UiResponse,
  type UiCancel,
  type UiCommandInvocation,
  type UiCommandResult,
  type UiContextEvent,
} from './ui-dto';
export type * from './ui-dto';
export { UI_LIMITS } from './ui-json';
export type { UiJson } from './ui-json';
export { UI_ERROR_CODES } from './ui-dto';
export const UI_METHODS = [
  'runtime.getCapabilities',
  'commands.register',
  'commands.unregister',
  'reader.consumeSelection',
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.list',
] as const satisfies readonly UiMethod[];
const revision = (v: unknown) => uiInteger(v, 1, Number.MAX_SAFE_INTEGER);
const key = (v: unknown) => uiString(v, 256);
const cursor = (v: unknown) => uiString(v, 1024);
const receipt = (v: Record<string, unknown>) =>
  uiKeys(v, ['revision', 'receiptId']) && revision(v.revision) && uiId(v.receiptId);
function params(method: UiMethod, p: Record<string, unknown>): boolean {
  switch (method) {
    case 'runtime.getCapabilities':
      return uiKeys(p, []);
    case 'commands.register':
      return uiKeys(p, ['commandId', 'handlerId']) && uiId(p.commandId) && uiId(p.handlerId);
    case 'commands.unregister':
      return uiKeys(p, ['registrationId']) && uiId(p.registrationId);
    case 'reader.consumeSelection':
      return uiKeys(p, ['token']) && uiId(p.token);
    case 'storage.get':
      return uiKeys(p, ['key']) && key(p.key);
    case 'storage.set':
      return (
        uiKeys(p, ['key', 'value', 'expectedRevision', 'idempotencyKey']) &&
        key(p.key) &&
        isUiJson(p.value, UI_LIMITS.valueBytes) &&
        (p.expectedRevision === null || revision(p.expectedRevision)) &&
        uiId(p.idempotencyKey)
      );
    case 'storage.remove':
      return (
        uiKeys(p, ['key', 'expectedRevision', 'idempotencyKey']) &&
        key(p.key) &&
        revision(p.expectedRevision) &&
        uiId(p.idempotencyKey)
      );
    case 'storage.list':
      return (
        uiKeys(p, ['limit'], ['prefix', 'cursor']) &&
        uiInteger(p.limit, 1, 100) &&
        (p.prefix === undefined || p.prefix === '' || key(p.prefix)) &&
        (p.cursor === undefined || cursor(p.cursor))
      );
  }
}
function result(method: UiMethod, r: unknown): boolean {
  if (method === 'commands.unregister') return r === null;
  if (!uiRecord(r)) return false;
  switch (method) {
    case 'runtime.getCapabilities':
      return (
        uiKeys(r, ['apiVersion', 'apiMinor', 'features']) &&
        r.apiVersion === 1 &&
        r.apiMinor === 0 &&
        Array.isArray(r.features) &&
        r.features.length <= UI_FEATURES.length &&
        new Set(r.features).size === r.features.length &&
        r.features.every((f) => UI_FEATURES.includes(f))
      );
    case 'commands.register':
      return uiKeys(r, ['registrationId']) && uiId(r.registrationId);
    case 'reader.consumeSelection': {
      const loc = r.location;
      if (
        !uiKeys(r, ['schemaVersion', 'text', 'location', 'capturedAt', 'textSource']) ||
        r.schemaVersion !== 1 ||
        typeof r.text !== 'string' ||
        uiUtf8Size(r.text) > UI_LIMITS.selectionBytes ||
        !uiRecord(loc) ||
        !uiKeys(loc, ['schemaVersion', 'bookId', 'documentRevision', 'locator']) ||
        loc.schemaVersion !== 1 ||
        !uiString(loc.bookId, 128) ||
        !uiString(loc.documentRevision, 128) ||
        !uiString(loc.locator, 4096) ||
        !uiString(r.capturedAt, 24) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.capturedAt) ||
        !['original', 'ocr'].includes(r.textSource as string)
      )
        return false;
      return Number.isFinite(Date.parse(r.capturedAt)) && new Date(r.capturedAt).toISOString() === r.capturedAt;
    }
    case 'storage.get':
      return r.found === false
        ? uiKeys(r, ['found'])
        : r.found === true &&
            uiKeys(r, ['found', 'value', 'revision']) &&
            revision(r.revision) &&
            isUiJson(r.value, UI_LIMITS.valueBytes);
    case 'storage.set':
    case 'storage.remove':
      return receipt(r);
    case 'storage.list': {
      if (
        !uiKeys(r, ['items'], ['nextCursor']) ||
        !Array.isArray(r.items) ||
        r.items.length > 100 ||
        (r.nextCursor !== undefined && !cursor(r.nextCursor))
      )
        return false;
      const keys = new Set();
      return r.items.every((i) => {
        if (
          !uiRecord(i) ||
          !uiKeys(i, ['key', 'value', 'revision']) ||
          !key(i.key) ||
          keys.has(i.key) ||
          !revision(i.revision) ||
          !isUiJson(i.value, UI_LIMITS.valueBytes)
        )
          return false;
        keys.add(i.key);
        return true;
      });
    }
  }
}
function envelope(value: unknown, kind: string, maximum: number): value is Record<string, unknown> {
  return (
    isUiJson(value, maximum) &&
    uiRecord(value) &&
    value.wireVersion === 1 &&
    value.kind === kind &&
    uiId(value.sessionId) &&
    uiId(value.requestId)
  );
}
/** Shape only: caller must also bind port/session, lifecycle, grant, method and unique request ID. */
export function validateUiRequest(v: unknown): v is UiRequest {
  return (
    envelope(v, 'request', UI_LIMITS.requestBytes) &&
    uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId', 'method', 'params']) &&
    UI_METHODS.includes(v.method as UiMethod) &&
    uiRecord(v.params) &&
    params(v.method as UiMethod, v.params)
  );
}
/** Bind to the pending request's method, never to a method claimed by the response. */
export function validateUiResponse<M extends UiMethod>(v: unknown, method: M): v is UiResponse<M> {
  if (!UI_METHODS.includes(method) || !envelope(v, 'response', UI_LIMITS.responseBytes)) return false;
  if (v.ok === true)
    return uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId', 'ok', 'result']) && result(method, v.result);
  return (
    v.ok === false &&
    uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId', 'ok', 'error']) &&
    uiRecord(v.error) &&
    uiKeys(v.error, ['code', 'retryable']) &&
    UI_ERROR_CODES.includes(v.error.code as (typeof UI_ERROR_CODES)[number]) &&
    typeof v.error.retryable === 'boolean'
  );
}
export function validateUiCancel(v: unknown): v is UiCancel {
  return envelope(v, 'cancel', UI_LIMITS.requestBytes) && uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId']);
}
export function validateUiCommandInvocation(v: unknown): v is UiCommandInvocation {
  return (
    envelope(v, 'invoke', UI_LIMITS.requestBytes) &&
    uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId', 'handlerId', 'invocationId'], ['selectionToken']) &&
    uiId(v.handlerId) &&
    uiId(v.invocationId) &&
    (v.selectionToken === undefined || uiId(v.selectionToken))
  );
}
export function validateUiCommandResult(v: unknown): v is UiCommandResult {
  return (
    envelope(v, 'invocationResult', UI_LIMITS.responseBytes) &&
    uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'requestId', 'ok']) &&
    typeof v.ok === 'boolean'
  );
}
export function validateUiContextEvent(v: unknown): v is UiContextEvent {
  return (
    isUiJson(v, UI_LIMITS.responseBytes) &&
    uiRecord(v) &&
    uiKeys(v, ['wireVersion', 'kind', 'sessionId', 'eventId', 'sequence', 'event', 'payload']) &&
    v.wireVersion === 1 &&
    v.kind === 'event' &&
    uiId(v.sessionId) &&
    uiId(v.eventId) &&
    uiInteger(v.sequence, 1, Number.MAX_SAFE_INTEGER) &&
    v.event === 'ui.contextChanged' &&
    uiRecord(v.payload) &&
    uiKeys(v.payload, ['theme', 'locale', 'panelId']) &&
    ['light', 'dark'].includes(v.payload.theme as string) &&
    uiString(v.payload.locale, 64) &&
    uiId(v.payload.panelId)
  );
}
