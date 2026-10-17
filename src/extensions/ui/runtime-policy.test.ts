import { expect, it } from 'vitest';
import { requireEnvironment } from './runtime-policy';
function windowFixture(extra: object = {}): Window {
  return {
    isSecureContext: true,
    crypto,
    MessageChannel,
    Blob,
    location: new URL('https://boaa.example/'),
    ...extra,
  } as unknown as Window;
}
it('keeps unverified native, static, insecure and explicit recovery environments off', () => {
  expect(() => requireEnvironment(windowFixture(), 'self-host')).not.toThrow();
  for (const extra of [
    { isSecureContext: false },
    { crypto: undefined },
    { __TAURI_INTERNALS__: undefined },
    { __TAURI__: {} },
    { Capacitor: {} },
    { isTauri: false },
    { location: new URL('https://tauri.localhost/') },
    { location: new URL('https://boaa.example/?plugins=on&plugins=off') },
  ])
    expect(() => requireEnvironment(windowFixture(extra), 'self-host')).toThrow('CAPABILITY_UNAVAILABLE');
  for (const deployment of ['native', 'static'] as const)
    expect(() => requireEnvironment(windowFixture(), deployment)).toThrow('CAPABILITY_UNAVAILABLE');
});
