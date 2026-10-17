import { UI_ERROR_CODES } from '@boaa/extension-contracts/ui-protocol';
export const RUNTIME_LIMITS = Object.freeze({
  instances: 3,
  startupMs: 5000,
  shutdownMs: 500,
  readMs: 3000,
  writeMs: 5000,
  concurrent: 4,
  queued: 16,
  burst: 100,
  rate: 50,
  selectionMs: 30000,
  invocationMs: 5000,
});
export class UiRuntimeError extends Error {
  constructor(readonly code: (typeof UI_ERROR_CODES)[number]) {
    super(code);
    this.name = 'UiRuntimeError';
  }
}
export function errorCode(error: unknown): (typeof UI_ERROR_CODES)[number] {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return UI_ERROR_CODES.includes(code as (typeof UI_ERROR_CODES)[number])
    ? (code as (typeof UI_ERROR_CODES)[number])
    : 'INTERNAL_ERROR';
}
export function requireRuntime(ok: unknown, code: (typeof UI_ERROR_CODES)[number]): asserts ok {
  if (!ok) throw new UiRuntimeError(code);
}
/** Only validated secure self-host browsers may run guests; recovery mode may expose management alone. */
export function requireEnvironment(
  win: Window,
  deployment: 'self-host' | 'static' | 'native',
  managementOnly = false,
): void {
  const globals = win as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown; Capacitor?: unknown };
  requireRuntime(
    deployment === 'self-host' &&
      win.isSecureContext &&
      !('__TAURI_INTERNALS__' in globals) &&
      !('__TAURI__' in globals) &&
      !('Capacitor' in globals) &&
      !('isTauri' in globals) &&
      win.location.protocol !== 'tauri:' &&
      win.location.hostname !== 'tauri.localhost' &&
      !!win.crypto?.subtle &&
      'MessageChannel' in win &&
      'Blob' in win &&
      (managementOnly || !new URL(win.location.href).searchParams.getAll('plugins').includes('off')),
    'CAPABILITY_UNAVAILABLE',
  );
}
