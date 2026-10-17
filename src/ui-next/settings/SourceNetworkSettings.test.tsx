import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceNetworkSettings as Settings } from '../../../packages/extension-contracts/source-network-settings';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import { SourceNetworkSettings } from './SourceNetworkSettings';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    revision: 3,
    defaultProxy: 'socks5://proxy:1080',
    origin: 'settings',
    effectiveProxy: 'socks5://proxy:1080',
    byedpi: { available: true, enabled: false, running: false },
    ...overrides,
  };
}

function manager(networkSettings: InstalledExtensionManager['networkSettings']) {
  return {
    target: 'server',
    networkSettings,
    getSnapshot: () => ({ error: undefined }),
    subscribe: () => () => undefined,
  } as unknown as InstalledExtensionManager;
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map(text).join('');
}

async function open(value: InstalledExtensionManager) {
  await act(async () => {
    renderer = create(<SourceNetworkSettings manager={value} />);
  });
  const root = renderer!.root;
  await act(async () => root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
  return root;
}

function option(root: ReactTestInstance, label: string) {
  return root.find((node) => node.props.role === 'radio' && text(node).startsWith(label));
}

it('turns ByeDPI on without an address and keeps the saved custom proxy', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings())
    .mockResolvedValueOnce(
      settings({
        revision: 4,
        effectiveProxy: 'socks5://byedpi:1080',
        byedpi: { available: true, enabled: true, running: true },
      }),
    );
  const root = await open(manager(request));
  expect(option(root, '내 프록시').props['aria-checked']).toBe(true);
  expect(text(root)).toContain('외부 Suwayomi 서버는 그 서버의 프록시 설정을 따르고');

  await act(async () => option(root, 'ByeDPI 우회').props.onClick());
  expect(request).toHaveBeenLastCalledWith(
    { revision: 3, defaultProxy: 'socks5://proxy:1080', byedpiEnabled: true },
    expect.anything(),
  );
  expect(option(root, 'ByeDPI 우회').props['aria-checked']).toBe(true);
  expect(text(root)).toContain('저장한 주소: socks5://proxy:1080');
  expect(root.findAllByType('input')).toHaveLength(0);
});

it('keeps the previous mode when ByeDPI fails to start', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings({ defaultProxy: '', effectiveProxy: '', origin: 'direct' }))
    .mockRejectedValueOnce(new RemoteApiError('byedpi_start_failed', 503));
  const root = await open(manager(request));
  await act(async () => option(root, 'ByeDPI 우회').props.onClick());
  expect(text(root)).toContain('ByeDPI를 시작하지 못했어요');
  expect(option(root, '직접 연결').props['aria-checked']).toBe(true);
});

it('warns instead of falling back to direct while an enabled ByeDPI restarts', async () => {
  const request = vi.fn().mockResolvedValue(settings({ byedpi: { available: true, enabled: true, running: false } }));
  const root = await open(manager(request));
  expect(text(root)).toContain('직접 연결로 바꾸지 않고');
  expect(text(root)).toContain('ByeDPI (시작 대기)');
});

it('saves a custom proxy and switches ByeDPI off', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      settings({ defaultProxy: '', origin: 'direct', byedpi: { available: true, enabled: true, running: true } }),
    )
    .mockResolvedValueOnce(settings({ revision: 4, defaultProxy: 'http://p:8080' }));
  const root = await open(manager(request));
  await act(async () => option(root, '내 프록시').props.onClick());
  expect(request).toHaveBeenCalledTimes(1);
  const input = root.findByType('input');
  act(() => input.props.onChange({ target: { value: ' http://p:8080 ' } }));
  await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(request).toHaveBeenLastCalledWith(
    { revision: 3, defaultProxy: 'http://p:8080', byedpiEnabled: false },
    expect.anything(),
  );
});

it('hides the ByeDPI option for hosts that do not report it', async () => {
  const request = vi.fn().mockResolvedValue(settings({ byedpi: undefined }));
  const root = await open(manager(request));
  expect(root.findAll((node) => node.props.role === 'radio')).toHaveLength(2);
  await act(async () => option(root, '직접 연결').props.onClick());
  expect(request).toHaveBeenLastCalledWith({ revision: 3, defaultProxy: '' }, expect.anything());
});

it('stays out of the way where the host has no source network settings', async () => {
  await act(async () => {
    renderer = create(<SourceNetworkSettings manager={manager(undefined)} />);
  });
  expect(renderer!.toJSON()).toBeNull();
  act(() => renderer?.unmount());

  const root = await open(manager(vi.fn().mockRejectedValue(new RemoteApiError('Not Found', 404))));
  expect(root.findAllByType('details')).toHaveLength(0);
});

it('keeps a half-typed custom proxy while the ByeDPI health refresh runs', async () => {
  vi.useFakeTimers();
  try {
    const stalled = settings({
      defaultMode: 'byedpi',
      defaultProxy: '',
      origin: 'direct',
      byedpi: { available: true, enabled: true, running: false },
    });
    const request = vi.fn().mockResolvedValue(stalled);
    const root = await open(manager(request));
    await act(async () => option(root, '내 프록시').props.onClick());
    act(() => root.findByType('input').props.onChange({ target: { value: 'socks5://typing' } }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(request.mock.calls.slice(1).every((call) => call[0] === undefined)).toBe(true);
    expect(option(root, '내 프록시').props['aria-checked']).toBe(true);
    expect(root.findByType('input').props.value).toBe('socks5://typing');
    expect(root.findByType('input').props.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('follows the health refresh when nothing is being edited', async () => {
  vi.useFakeTimers();
  try {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        settings({ defaultMode: 'byedpi', byedpi: { available: true, enabled: true, running: false } }),
      )
      .mockResolvedValue(
        settings({ defaultMode: 'byedpi', byedpi: { available: true, enabled: true, running: true } }),
      );
    const root = await open(manager(request));
    expect(text(root)).toContain('ByeDPI (시작 대기)');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(text(root)).not.toContain('시작 대기');
    expect(text(root)).not.toContain('처리 중');
  } finally {
    vi.useRealTimers();
  }
});

it('sends explicit modes to servers that report one and keeps the saved address for direct', async () => {
  const modern = settings({ defaultMode: 'custom' });
  const request = vi
    .fn()
    .mockResolvedValueOnce(modern)
    .mockResolvedValueOnce(settings({ revision: 4, defaultMode: 'direct', effectiveProxy: '' }))
    .mockResolvedValueOnce(settings({ revision: 5, defaultMode: 'custom' }))
    .mockResolvedValueOnce(settings({ revision: 6, defaultMode: 'custom', origin: 'environment' }));
  const root = await open(manager(request));

  await act(async () => option(root, '직접 연결').props.onClick());
  expect(request).toHaveBeenLastCalledWith(
    { revision: 3, defaultProxy: 'socks5://proxy:1080', defaultMode: 'direct', byedpiEnabled: false },
    expect.anything(),
  );
  // The address survived on the server, so 내 프록시 switches back without typing.
  expect(text(root)).toContain('저장한 주소: socks5://proxy:1080');
  await act(async () => option(root, '내 프록시').props.onClick());
  expect(request).toHaveBeenLastCalledWith(
    { revision: 4, defaultProxy: 'socks5://proxy:1080', defaultMode: 'custom', byedpiEnabled: false },
    expect.anything(),
  );

  await act(async () =>
    root.find((node) => node.type === 'button' && text(node) === '서버 기본값으로').props.onClick(),
  );
  expect(request).toHaveBeenLastCalledWith(
    { revision: 5, defaultProxy: null, byedpiEnabled: false },
    expect.anything(),
  );
});

it('waits for a slow health answer instead of cancelling it on every tick', async () => {
  vi.useFakeTimers();
  try {
    const stalled = settings({ defaultMode: 'byedpi', byedpi: { available: true, enabled: true, running: false } });
    const running = settings({ defaultMode: 'byedpi', byedpi: { available: true, enabled: true, running: true } });
    let calls = 0;
    const request = vi.fn((_request?: unknown, signal?: AbortSignal) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(stalled);
      // Every health answer takes 7 seconds, longer than the 5-second refresh interval.
      return new Promise<Settings>((resolve, reject) =>
        globalThis.setTimeout(() => (signal?.aborted ? reject(new Error('aborted')) : resolve(running)), 7_000),
      );
    });
    const root = await open(manager(request as unknown as InstalledExtensionManager['networkSettings']));
    expect(text(root)).toContain('ByeDPI (시작 대기)');
    for (let second = 0; second < 14; second += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    expect(text(root)).not.toContain('시작 대기');
  } finally {
    vi.useRealTimers();
  }
});
