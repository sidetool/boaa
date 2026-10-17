export const SELF_HOST_AUTH_REQUIRED_EVENT = 'boaa:self-host-auth-required';

export function notifySelfHostAuthRequired(): void {
  globalThis.dispatchEvent?.(new Event(SELF_HOST_AUTH_REQUIRED_EVENT));
}

export const SELF_HOST_AUTH_ENDING_EVENT = 'boaa:self-host-auth-ending';
