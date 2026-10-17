import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  sessions: [] as {
    close: ReturnType<typeof vi.fn>;
    service: { startSession: ReturnType<typeof vi.fn> };
    deployment: unknown;
  }[],
  account: { username: 'reader', displayName: 'Reader' },
}));
vi.mock('../../features/auth/SelfHostAccountGate', () => ({
  useOptionalSelfHostAuth: () => ({ account: mocks.account }),
}));
vi.mock('../ui/runtime-policy', () => ({ requireEnvironment: () => {} }));
vi.mock('./product-session', () => ({
  loadPluginDeployment: mocks.load,
  ProductPluginSession: class {
    off = false;
    store = { finishRetirements: vi.fn(async () => {}) };
    service = { startSession: vi.fn(async () => {}) };
    close = vi.fn(async () => {});
    constructor(readonly deployment: unknown) {
      mocks.sessions.push(this);
    }
  },
}));
import { PlatformPluginProvider, useProductPlugins } from './PlatformPluginProvider';
import { SELF_HOST_AUTH_ENDING_EVENT } from '../../services/remote/self-host-auth-events';
const runtime = { mode: 'remote', apiBaseUrl: '/api' } as ReaderRuntime;
function Probe() {
  const value = useProductPlugins();
  return <p>{value.session ? 'running' : value.message}</p>;
}
let app: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
  if (app) await act(async () => app.unmount());
  mocks.sessions.length = 0;
  mocks.load.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('starts once in StrictMode and closes on unmount', async () => {
  mocks.load.mockResolvedValue({ serverId: 'one' });
  await act(async () => {
    app = create(
      <StrictMode>
        <PlatformPluginProvider runtime={runtime}>
          <Probe />
        </PlatformPluginProvider>
      </StrictMode>,
    );
  });
  expect(app.root.findByType('p').children).toEqual(['running']);
  expect(mocks.sessions).toHaveLength(1);
  await act(async () => app.unmount());
  expect(mocks.sessions[0].close).toHaveBeenCalled();
});
it('stops at logout intent before the logout network request finishes', async () => {
  mocks.load.mockResolvedValue({ serverId: 'one' });
  await act(async () => {
    app = create(
      <PlatformPluginProvider runtime={runtime}>
        <Probe />
      </PlatformPluginProvider>,
    );
  });
  await act(async () => {
    window.dispatchEvent(new Event(SELF_HOST_AUTH_ENDING_EVENT));
  });
  expect(mocks.sessions[0].close).toHaveBeenCalled();
  expect(app.root.findByType('p').children).not.toEqual(['running']);
});
it('never starts a stale response after unmount', async () => {
  let resolve!: (value: unknown) => void;
  mocks.load.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => {
    app = create(
      <PlatformPluginProvider runtime={runtime}>
        <Probe />
      </PlatformPluginProvider>,
    );
  });
  expect(mocks.load).toHaveBeenCalled();
  await act(async () => app.unmount());
  await act(async () => {
    resolve({ serverId: 'old' });
  });
  expect(mocks.sessions).toHaveLength(0);
});
it('stops when the server/account context changes without navigation', async () => {
  vi.useFakeTimers();
  mocks.load.mockResolvedValueOnce({ serverId: 'one' }).mockResolvedValue({ serverId: 'two' });
  await act(async () => {
    app = create(
      <PlatformPluginProvider runtime={runtime}>
        <Probe />
      </PlatformPluginProvider>,
    );
  });
  expect(app.root.findByType('p').children).toEqual(['running']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(mocks.sessions[0].close).toHaveBeenCalled();
  expect(app.root.findByType('p').children).not.toEqual(['running']);
});

it('does not revoke an unchanged scope when JSON property order differs', async () => {
  vi.useFakeTimers();
  mocks.load
    .mockResolvedValueOnce({ serverId: 'one', accountId: 'alice' })
    .mockResolvedValue({ accountId: 'alice', serverId: 'one' });
  await act(async () => {
    app = create(
      <PlatformPluginProvider runtime={runtime}>
        <Probe />
      </PlatformPluginProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(mocks.sessions[0].close).not.toHaveBeenCalled();
  expect(app.root.findByType('p').children).toEqual(['running']);
});

it.each(['PLUGIN_DEPLOYMENT_DISABLED', 'CAPABILITY_UNAVAILABLE', 'Network request failed'])(
  'preserves the message and exposes only machine code messages: %s',
  async (message) => {
    mocks.load.mockRejectedValueOnce(new Error(message));
    let value!: ReturnType<typeof useProductPlugins>;
    function Capture() {
      value = useProductPlugins();
      return null;
    }
    await act(async () => {
      app = create(createElement(PlatformPluginProvider, { runtime, children: createElement(Capture) }));
    });
    expect(value.message).toBe(message);
    expect(value.code).toBe(message.includes(' ') ? undefined : message);
    expect(value.session).toBeUndefined();
    mocks.load.mockResolvedValue({ serverId: 'one' });
    await act(async () => {
      value.retry();
    });
    expect(value.code).toBeUndefined();
    expect(value.session).toBeDefined();
  },
);
