import { afterEach, expect, it, vi } from 'vitest';
import { withSelfHostAuthMutation } from './self-host-auth-mutation';

afterEach(() => vi.unstubAllGlobals());
it('uses the same origin lock for login and password and checks the captured lifetime after waiting', async () => {
  const callbacks: (() => Promise<unknown>)[] = [];
  const names: string[] = [];
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, _options: unknown, callback: () => Promise<unknown>) => {
        names.push(name);
        return new Promise((resolve, reject) =>
          callbacks.push(async () => {
            try {
              resolve(await callback());
            } catch (error) {
              reject(error);
            }
          }),
        );
      },
    },
  });
  const controller = new AbortController();
  const send = vi.fn(async () => 200);
  const first = withSelfHostAuthMutation('https://fixture.invalid/api/auth/login', async () => 200);
  const second = withSelfHostAuthMutation('https://fixture.invalid/api/auth/password', send, controller.signal);
  expect(names[0]).toBe(names[1]);
  controller.abort();
  await callbacks[0]();
  expect(await first).toBe(200);
  await callbacks[1]();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(send).not.toHaveBeenCalled();
});
it('fails closed in browsers without Web Locks', async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {});
  const send = vi.fn();
  await expect(withSelfHostAuthMutation('/api', send)).rejects.toThrow('Web Locks');
  expect(send).not.toHaveBeenCalled();
});
