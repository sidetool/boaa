import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Installation } from './store-model';
import type { ProductPluginSession } from './product-session';
import type { PluginConnectionStatus } from './plugin-http';
import { PLUGIN_HTTP_METHODS } from '../../../packages/extension-contracts/plugin-http';
import { usePluginConnectionModel, type PluginConnectionModel } from './use-plugin-connection-model';
let app: ReactTestRenderer;
afterEach(() => act(() => app?.unmount()));
function setup(list = vi.fn().mockResolvedValue([])) {
  const owner = { profileId: 'profile', installationId: 'installation', digest: 'digest', generation: 1 };
  const http = {
    list,
    owner: vi.fn(() => owner),
    host: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  const session = { http, off: false } as unknown as ProductPluginSession;
  const row = {
    installationId: 'installation',
    revision: 1,
    active: 'digest',
    enabled: true,
    manifest: { entries: { controller: { permissions: ['http.request'] }, ui: { permissions: [] } } },
  } as unknown as Installation;
  let model!: PluginConnectionModel;
  function Harness() {
    model = usePluginConnectionModel({ session, row, slot: 'api' });
    return null;
  }
  return {
    http,
    owner,
    row,
    session,
    Harness,
    get model() {
      return model;
    },
  };
}
it('restores saved values, derives choices and submits approval and revocation without exposing secrets', async () => {
  const saved: PluginConnectionStatus = {
    slot: 'api',
    endpoint: 'https://api.example.com/',
    methods: ['GET'],
    headers: ['accept'],
    roles: ['controller'],
    revision: 'revision',
    authenticated: true,
  };
  const state = setup(vi.fn().mockResolvedValue([saved]));
  await act(async () => {
    app = create(createElement(state.Harness));
  });
  expect(state.model.saved).toEqual(saved);
  expect(state.model.endpoint).toBe(saved.endpoint);
  expect(state.model.allowedHeaders).toBe('accept');
  expect(state.model.secret).toBe('');
  expect(state.model.auth).toBe('none');
  expect(state.model.methodOptions).toEqual(PLUGIN_HTTP_METHODS);
  expect(state.model.roleOptions).toEqual(['controller']);
  act(() => {
    state.model.setEndpoint('https://api.example.com/v2/');
    state.model.setAuth('header');
    state.model.setHeader('x-token');
    state.model.setSecret('private-key');
    state.model.setAllowedHeaders('accept, , content-type ');
    state.model.setMethod('POST', true);
    state.model.setMethod('GET', false);
    state.model.setRole('controller', false);
    state.model.setRole('controller', true);
  });
  let finish!: () => void;
  state.http.host.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = state.model.approve();
  });
  expect(state.model.busy).toBe(true);
  expect(state.model.disabled).toBe(true);
  expect(state.http.host).toHaveBeenCalledWith('approve', state.owner, {
    slot: 'api',
    endpoint: 'https://api.example.com/v2/',
    methods: ['POST'],
    headers: ['accept', 'content-type'],
    roles: ['controller'],
    auth: { kind: 'header', header: 'x-token', value: 'private-key' },
  });
  await act(async () => {
    finish();
    await pending;
  });
  expect(state.model.secret).toBe('');
  expect(state.model.busy).toBe(false);
  act(() => state.model.setAuth('none'));
  await act(async () => {
    await state.model.approve();
  });
  expect(state.http.host).toHaveBeenLastCalledWith(
    'approve',
    state.owner,
    expect.objectContaining({ auth: { kind: 'none' } }),
  );
  state.http.list.mockResolvedValue([]);
  await act(async () => {
    await state.model.revoke();
  });
  expect(state.http.revoke).toHaveBeenCalledWith(state.row, 'api');
  expect(state.model.saved).toBeUndefined();
});
it('reports load/mutation failures as codes and preserves the secret when approval fails', async () => {
  const state = setup(vi.fn().mockRejectedValue(new Error('offline')));
  await act(async () => {
    app = create(createElement(state.Harness));
  });
  expect(state.model.error).toBe('load_failed');
  act(() => state.model.setSecret('retry-key'));
  state.http.host.mockRejectedValueOnce(new Error('denied'));
  await act(async () => {
    await state.model.approve();
  });
  expect(state.model.error).toBe('mutation_failed');
  expect(state.model.secret).toBe('retry-key');
  expect(state.model.busy).toBe(false);
  state.http.list.mockResolvedValue([]);
  await act(async () => {
    await state.model.approve();
  });
  expect(state.model.error).toBeUndefined();
  expect(state.model.secret).toBe('');
  state.http.revoke.mockRejectedValueOnce(new Error('denied'));
  await act(async () => {
    await state.model.revoke();
  });
  expect(state.model.error).toBe('mutation_failed');
});
it('ignores an initial list response after unmount', async () => {
  let resolve!: (value: PluginConnectionStatus[]) => void;
  const state = setup(
    vi.fn(
      () =>
        new Promise<PluginConnectionStatus[]>((done) => {
          resolve = done;
        }),
    ),
  );
  await act(async () => {
    app = create(createElement(state.Harness));
  });
  const initial = state.model;
  act(() => app.unmount());
  await act(async () => {
    resolve([]);
  });
  expect(state.model).toBe(initial);
});
