import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelfHostSession } from './self-host-session';

const context = (userId = 'a', sessionContext = 'session-a') => ({
  serverId: 'server',
  accountId: userId,
  libraryId: 'library',
  account: { userId, username: 'same-name', displayName: 'Reader', role: 'member' as const },
  sessionContext,
  capabilities: {
    manageServer: false,
    manageExtensions: false,
    useSources: true,
    useProviders: false,
    exportLibrary: true,
    restoreLibrary: false,
    manageAccounts: false,
  },
  legacyDataOwner: false,
});
afterEach(() => vi.unstubAllGlobals());
describe('immutable cookie ownership', () => {
  it('never forwards a stored bearer and sends its immutable context', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const session = new SelfHostSession(context(), '/api');
    await session.fetch('/api/books', { headers: { Authorization: 'Bearer old-owner' } });
    const options = fetch.mock.calls[0][1];
    expect(options.headers.get('Authorization')).toBeNull();
    expect(options.headers.get('X-BOAA-Session-Context')).toBe('session-a');
    expect(options.cache).toBe('no-store');
  });
  it('scopes immutable IDs and server installations, not usernames or session tokens', () => {
    const a = new SelfHostSession(context(), '/api');
    expect(new SelfHostSession(context('a', 'next-session'), '/api').storageScope).toBe(a.storageScope);
    expect(new SelfHostSession(context('b'), '/api').storageScope).not.toBe(a.storageScope);
    expect(new SelfHostSession({ ...context(), serverId: 'replacement' }, '/api').storageScope).not.toBe(
      a.storageScope,
    );
  });
  it('rejects an old-tab cookie mismatch without replay and names only its originating epoch', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'session_context_mismatch' }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const old = new SelfHostSession(context(), '/api');
    const next = new SelfHostSession(context('b', 'session-b'), '/api');
    const listener = vi.fn();
    vi.stubGlobal('dispatchEvent', listener);
    await expect(old.fetch('/api/books', { method: 'POST' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail.epoch).toBe(old.epoch);
    expect(next.signal.aborted).toBe(false);
  });
  it('does not end a valid session on admin denial and refuses new work after disposal', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const session = new SelfHostSession(context(), '/api');
    expect((await session.fetch('/api/admin/accounts')).status).toBe(403);
    expect(session.signal.aborted).toBe(false);
    session.dispose();
    await expect(session.fetch('/api/books')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('dispatches the validated API URL and preserves a Request body, method, headers and cancellation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const session = new SelfHostSession(context(), 'http://localhost/deployment/api');
  await session.fetch('books');
  expect(fetch.mock.calls[0][0]).toBe('http://localhost/deployment/api/books');
  const controller = new AbortController();
  const input = new Request('http://localhost/deployment/api/books', {
    method: 'POST',
    body: 'body',
    headers: { 'Content-Type': 'text/plain', Authorization: 'Bearer forbidden' },
    signal: controller.signal,
  });
  await session.fetch(input);
  const [request, init] = fetch.mock.calls[1];
  expect(request).toBe(input);
  expect(request.method).toBe('POST');
  expect(await request.text()).toBe('body');
  expect(init.headers.get('Content-Type')).toBe('text/plain');
  expect(init.headers.has('Authorization')).toBe(false);
  expect(init.redirect).toBe('error');
  controller.abort();
  expect(init.signal.aborted).toBe(true);
  await expect(session.fetch('http://elsewhere.invalid/api/books')).rejects.toThrow('left its server API');
  expect(fetch).toHaveBeenCalledTimes(2);
});
