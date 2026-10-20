import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EncryptedSourceCredentialVault } from './source-credential-vault';
import { sourceBrowserHttp } from './source-browser-cookies';
import { readBrowserSession, mergeBrowserSession, writeBrowserSession } from './source-browser-session';
it('retains cookies from redirect hops and the browser identity in preference to stale maker identity', async () => {
  let secret = '';
  const scope = {
    key: 'one',
    vault: {
      read: () => (secret ? { secret } : undefined),
      write: (_key: string, value?: { secret: string }) => {
        secret = value?.secret ?? '';
      },
    },
  };
  writeBrowserSession(scope, { cookies: [], origins: [], userAgents: { 'https://site.example': 'Browser UA' } });
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  await sourceBrowserHttp(
    { url: 'https://site.example/start' },
    AbortSignal.timeout(1000),
    scope,
    1024,
    async (input) => {
      calls.push(input);
      return input.url.endsWith('/start')
        ? {
            statusCode: 302,
            headers: { location: '/end', 'set-cookie': ['session=valid; Path=/; Secure'] },
            bytes: Buffer.from(''),
            contentType: 'text/plain',
            url: input.url,
          }
        : { statusCode: 200, headers: {}, bytes: Buffer.from('done'), contentType: 'text/plain', url: input.url };
    },
    true,
  );
  expect(calls[1].headers).toMatchObject({ 'user-agent': 'Browser UA', cookie: 'session=valid' });
  await sourceBrowserHttp(
    { url: 'https://site.example/end', headers: { 'User-Agent': 'Maker UA' } },
    AbortSignal.timeout(1000),
    scope,
    1024,
    async (input) => {
      expect(input.headers?.['User-Agent']).toBeUndefined();
      expect(input.headers?.['user-agent']).toBe('Browser UA');
      return { statusCode: 200, headers: {}, bytes: Buffer.from('done'), contentType: 'text/plain', url: input.url };
    },
  );
  const before = readBrowserSession(scope);
  const other = { ...before.cookies[0], name: 'parallel', value: 'kept' };
  writeBrowserSession(scope, { ...before, cookies: [...before.cookies, other] });
  mergeBrowserSession(scope, before, { ...before, cookies: [{ ...before.cookies[0], value: 'updated' }] }, {});
  expect(readBrowserSession(scope).cookies.map((c) => [c.name, c.value])).toEqual([
    ['session', 'updated'],
    ['parallel', 'kept'],
  ]);
});

it('restores a large encrypted browser session after restart and rejects oversized updates', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'boaa-browser-session-'));
  try {
    const key = Buffer.alloc(32, 7);
    const scope = {
      key: JSON.stringify(['test-package', 'browser:source', 'epoch']),
      vault: new EncryptedSourceCredentialVault(directory, key),
    };
    const state = {
      cookies: [],
      origins: [{ origin: 'https://site.example', localStorage: [{ name: 'session', value: 'x'.repeat(100_000) }] }],
    };
    writeBrowserSession(scope, state);
    const restarted = { ...scope, vault: new EncryptedSourceCredentialVault(directory, key) };
    expect(readBrowserSession(restarted)).toEqual(state);
    expect(() => writeBrowserSession(scope, { ...state, userAgents: { extra: 'x'.repeat(1024 * 1024) } })).toThrow(
      'source_body_limit',
    );
    expect(readBrowserSession(restarted)).toEqual(state);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('starts a separate Camoufox session and leaves the previous engine state available for rollback', () => {
  const key = JSON.stringify(['package', 'browser:source', 'epoch']);
  const previous = JSON.stringify({ cookies: [], origins: [], userAgents: { 'https://site.example': 'Previous UA' } });
  const entries = new Map([[key, { secret: previous }]]);
  const scope = {
    key,
    vault: {
      read: (entry: string) => entries.get(entry),
      write: (entry: string, value?: { secret: string }) => {
        if (value) entries.set(entry, value);
        else entries.delete(entry);
      },
    },
  };
  expect(readBrowserSession(scope)).toEqual({ cookies: [], origins: [] });
  const current = { cookies: [], origins: [], userAgents: { 'https://site.example': 'Camoufox UA' } };
  writeBrowserSession(scope, current);
  expect(readBrowserSession(scope)).toEqual(current);
  expect(entries.get(key)?.secret).toBe(previous);
  expect(entries.size).toBe(2);
});

afterEach(() => vi.unstubAllEnvs());
it('keeps both engine sessions and restores each identity after switching back', () => {
  const entries = new Map<string, { secret: string }>();
  const scope = {
    key: JSON.stringify(['package', 'browser:source', 'epoch']),
    vault: {
      read: (key: string) => entries.get(key),
      write: (key: string, value?: { secret: string }) => {
        if (value) entries.set(key, value);
      },
    },
  };
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'camoufox');
  const state = { cookies: [], origins: [], userAgents: { 'https://fixture.invalid': 'Firefox fixture' } };
  writeBrowserSession(scope, state);
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'patchright');
  expect(readBrowserSession(scope)).toEqual({ cookies: [], origins: [] });
  writeBrowserSession(scope, { ...state, userAgents: { 'https://fixture.invalid': 'Chromium fixture' } });
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'camoufox');
  expect(readBrowserSession(scope)).toEqual(state);
  vi.stubEnv('BOAA_BROWSER_ENGINE', 'patchright');
  expect(readBrowserSession(scope).userAgents?.['https://fixture.invalid']).toBe('Chromium fixture');
});
