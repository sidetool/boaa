import { BOAA_PACKAGE_LIMITS } from './package-manifest';
import { uiId, uiKeys, uiRecord, uiUtf8Size } from './ui-json';
import { validateUiContextEvent, type UiContextEvent } from './ui-protocol';
export type UiContext = UiContextEvent['payload'];
export interface UiBootCode {
  kind: 'code';
  wireVersion: 1;
  sessionId: string;
  source: string;
  context: UiContext;
}
export interface UiLifecycle {
  kind: 'lifecycle';
  wireVersion: 1;
  sessionId: string;
  state: 'ready' | 'failed' | 'stop' | 'stopped';
}
export function validHello(v: unknown): v is { kind: 'hello'; wireVersion: 1; nonce: string } {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'nonce']) &&
    v.kind === 'hello' &&
    v.wireVersion === 1 &&
    typeof v.nonce === 'string' &&
    /^[a-f0-9]{32}$/.test(v.nonce)
  );
}
export function validBind(v: unknown): v is { kind: 'bind'; wireVersion: 1; nonce: string; sessionId: string } {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'nonce', 'sessionId']) &&
    v.kind === 'bind' &&
    validHello({ kind: 'hello', wireVersion: v.wireVersion, nonce: v.nonce }) &&
    uiId(v.sessionId)
  );
}
export function validBound(v: unknown, sessionId: string): boolean {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'sessionId']) &&
    v.kind === 'bound' &&
    v.wireVersion === 1 &&
    v.sessionId === sessionId
  );
}
export function validCode(v: unknown, sessionId: string): v is UiBootCode {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'sessionId', 'source', 'context']) &&
    v.kind === 'code' &&
    v.wireVersion === 1 &&
    v.sessionId === sessionId &&
    typeof v.source === 'string' &&
    uiUtf8Size(v.source) <= BOAA_PACKAGE_LIMITS.entryBytes &&
    validContext(v.context)
  );
}
export function validContext(v: unknown): v is UiContext {
  return validateUiContextEvent({
    wireVersion: 1,
    kind: 'event',
    sessionId: 's',
    eventId: 'e',
    sequence: 1,
    event: 'ui.contextChanged',
    payload: v,
  });
}
export function validLifecycle(v: unknown, sessionId: string): v is UiLifecycle {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'sessionId', 'state']) &&
    v.kind === 'lifecycle' &&
    v.wireVersion === 1 &&
    v.sessionId === sessionId &&
    ['ready', 'failed', 'stop', 'stopped'].includes(v.state as string)
  );
}

/** Private shell accessibility control. Never a data-sharing gesture or a guest SDK capability. */
export type UiSurfaceAction = 'escape' | 'previous' | 'next';
export function validSurface(v: unknown, sessionId: string): v is { action: UiSurfaceAction } {
  return (
    uiRecord(v) &&
    uiKeys(v, ['kind', 'wireVersion', 'sessionId', 'action']) &&
    v.kind === 'surface' &&
    v.wireVersion === 1 &&
    v.sessionId === sessionId &&
    ['escape', 'previous', 'next'].includes(v.action as string)
  );
}
