import { expect, it } from 'vitest';
import { validHello, validBind, validBound, validCode, validLifecycle } from './ui-lifecycle';
it('separates bounded bootstrap code from the regular RPC envelope and rejects extra authority fields', () => {
  const hello = { kind: 'hello', wireVersion: 1, nonce: 'a'.repeat(32) };
  expect(validHello(hello)).toBe(true);
  expect(validHello({ ...hello, nonce: '' })).toBe(false);
  expect(validBind({ ...hello, kind: 'bind', sessionId: 's' })).toBe(true);
  expect(validBind({ ...hello, kind: 'bind', sessionId: 's', pluginId: 'forged' })).toBe(false);
  expect(validBound({ kind: 'bound', wireVersion: 1, sessionId: 's' }, 'other')).toBe(false);
  const code = {
    kind: 'code',
    wireVersion: 1,
    sessionId: 's',
    source: 'x'.repeat(65537),
    context: { theme: 'dark', locale: 'ko', panelId: 'org.test.panel' },
  };
  expect(validCode(code, 's')).toBe(true);
  expect(validCode({ ...code, source: 'x'.repeat(5 * 1024 * 1024 + 1) }, 's')).toBe(false);
  expect(validCode({ ...code, context: { ...code.context, secret: 'no' } }, 's')).toBe(false);
  expect(validLifecycle({ kind: 'lifecycle', wireVersion: 1, sessionId: 's', state: 'ready' }, 's')).toBe(true);
  expect(
    validLifecycle({ kind: 'lifecycle', wireVersion: 1, sessionId: 's', state: 'ready', pluginId: 'forged' }, 's'),
  ).toBe(false);
});

it('accepts only bounded surface accessibility actions for the bound session', async () => {
  const { validSurface } = await import('./ui-lifecycle');
  const message = { kind: 'surface', wireVersion: 1, sessionId: 'session', action: 'escape' };
  for (const action of ['escape', 'previous', 'next'])
    expect(validSurface({ ...message, action }, 'session')).toBe(true);
  for (const changed of [{ action: 'share' }, { sessionId: 'other' }, { text: 'private' }, { wireVersion: 2 }])
    expect(validSurface({ ...message, ...changed }, 'session')).toBe(false);
});
