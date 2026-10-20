import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ServerComponent,
  ServerManagementRequest,
  ServerManagementStatus,
} from '../../../../packages/contracts/server-management';
import packageMetadata from '../../../../package.json';
import {
  ServerManagementClient,
  ServerManagementError,
} from '../../../features/server-management/server-management-client';
import { serverManagementApi } from '../../../features/server-management/use-server-management-client';
import { RemoteApiError } from '../../../services/remote/remote-api-contracts';
import type { AppRuntime } from '../../../app/runtime/app-runtime';
import { ServerPage } from './ServerPage';

// Sheets portal to document.body; render them inline so the confirmation flow can be driven here.
vi.mock('../../components/dialogs', () => ({
  ConfirmSheet: (props: {
    open: boolean;
    title: string;
    confirmLabel: string;
    children?: ReactNode;
    onConfirm(): void;
    onClose(): void;
  }) =>
    props.open ? (
      <div data-sheet={props.title}>
        {props.children}
        <button
          type="button"
          onClick={() => {
            props.onConfirm();
            props.onClose();
          }}
        >
          {`확인:${props.confirmLabel}`}
        </button>
      </div>
    ) : null,
}));

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

function component(overrides: Partial<ServerComponent> & Pick<ServerComponent, 'id'>): ServerComponent {
  return { installed: false, enabled: false, running: false, supported: true, managed: true, ...overrides };
}

function status(overrides: Partial<ServerManagementStatus> = {}): ServerManagementStatus {
  return {
    available: true,
    currentVersion: packageMetadata.version,
    channel: 'stable',
    phase: 'idle',
    busy: false,
    checkedAt: new Date().toISOString(),
    components: [
      component({ id: 'apk', downloadBytes: 180 * 1024 ** 2 }),
      component({ id: 'browser', installed: true, enabled: true, running: true, version: '1.2.0' }),
      component({ id: 'metadata', installed: true, enabled: false }),
    ],
    ...overrides,
  };
}

/** Accepts requests with 202-style ids; `autoComplete` lets the next GET report them finished. */
function fakeClient(initial: ServerManagementStatus | Error, autoComplete = true) {
  let current = initial;
  let sequence = 0;
  const client = {
    status: vi.fn(async () => {
      if (current instanceof Error) throw current;
      return current;
    }),
    request: vi.fn(async (request: ServerManagementRequest) => {
      const id = `r${++sequence}`;
      if (autoComplete && !(current instanceof Error)) {
        const at = new Date().toISOString();
        const done = { id, action: request.action, startedAt: at, completedAt: at, outcome: 'complete' as const };
        current = { ...current, operationResults: [done, ...(current.operationResults ?? [])] };
      }
      return { id };
    }),
    set(next: ServerManagementStatus | Error) {
      current = next;
    },
  };
  return client;
}

async function mount(client: ReturnType<typeof fakeClient>) {
  await act(async () => {
    renderer = create(<ServerPage client={client as unknown as ServerManagementClient} />);
  });
  return renderer!.root;
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map(text).join('');
}

function button(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'button' && text(node).trim() === label);
}

async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => node.props.onClick());
}

it('shows the release, change notes and asks before updating', async () => {
  const client = fakeClient(
    status({
      release: {
        version: '99.0.0',
        publishedAt: new Date().toISOString(),
        notes: '- 새 기능',
        url: 'https://example.test/r',
      },
    }),
  );
  const root = await mount(client);
  const page = text(root);
  expect(page).toContain('새 버전이 나왔어요');
  expect(page).toContain('v99.0.0 변경 내역');
  expect(page).toContain('- 새 기능');

  await click(button(root, '업데이트'));
  expect(client.request).not.toHaveBeenCalled();
  expect(text(root)).toContain('설치한 확장은 그대로 남아요');
  await click(button(root, '확인:업데이트'));
  expect(client.request).toHaveBeenCalledWith({ action: 'update' });
});

it('labels optional runtimes by state with download size and preserved data', async () => {
  const client = fakeClient(status());
  const root = await mount(client);
  const page = text(root);
  expect(page).toContain('APK 확장 실행기설치 안 됨');
  expect(page).toContain('받을 용량 180MB');
  expect(page).toContain('브라우저 인증사용 중');
  expect(page).toContain('지금 실행 중');
  expect(page).toContain('작품 정보 수집기중지됨');
  expect(page).toContain('로그인 정보, 서재는 그대로 남아요');

  // Every runtime change says the server restarts before anything is sent.
  await click(button(root, '설치'));
  expect(client.request).not.toHaveBeenCalled();
  expect(text(root)).toContain('최대 180MB를 받아 설치해요');
  expect(text(root)).toContain('서버가 잠시 다시 시작돼');
  await click(button(root, '확인:설치'));
  expect(client.request).toHaveBeenLastCalledWith({ action: 'component', componentId: 'apk', enabled: true });

  await click(button(root, '중지'));
  expect(text(root)).toContain('로그인 정보는 지우지 않아요');
  await click(button(root, '확인:중지'));
  expect(client.request).toHaveBeenLastCalledWith({ action: 'component', componentId: 'browser', enabled: false });

  await click(button(root, '켜기'));
  expect(text(root)).toContain('제공자는 앱에 들어 있지 않아요');
  await click(button(root, '확인:켜기'));
  expect(client.request).toHaveBeenLastCalledWith({ action: 'component', componentId: 'metadata', enabled: true });
});

it('explains the private provider before installing the metadata runtime', async () => {
  const root = await mount(
    fakeClient(status({ components: [component({ id: 'metadata', downloadBytes: 1024 ** 2 })] })),
  );
  expect(text(root)).toContain('제공자는 앱에 들어 있지 않아요');
  expect(text(root)).toContain('services/runtime-components/README.md');
  await click(button(root, '설치'));
  expect(text(root)).toContain('제공자 폴더를 따로 연결해야');
});

it('offers retry and stop for a failed runtime and hides controls for externally managed ones', async () => {
  const client = fakeClient(
    status({
      components: [
        component({ id: 'apk', installed: true, enabled: true, error: 'component_unavailable' }),
        component({
          id: 'metadata',
          installed: true,
          enabled: true,
          running: true,
          error: 'component_provider_missing',
        }),
        component({ id: 'browser', managed: false, installed: true, enabled: true }),
      ],
    }),
  );
  const root = await mount(client);
  expect(text(root)).toContain('실행기가 응답하지 않아요');
  expect(text(root)).toContain('작품 정보 수집기설정 필요');
  expect(text(root)).toContain('작품 정보 제공자가 아직 연결되지 않아');
  expect(text(root)).toContain('deploy/release-management.md');
  expect(text(root)).not.toContain('component_');
  expect(text(root)).toContain('직접 관리 중');
  // The failing APK runtime can be retried or stopped; the provider-missing one can be stopped.
  expect(root.findAll((node) => node.type === 'button' && text(node).trim() === '중지')).toHaveLength(2);
  await click(button(root, '다시 시도'));
  await click(button(root, '확인:다시 시도'));
  expect(client.request).toHaveBeenLastCalledWith({ action: 'component', componentId: 'apk', enabled: true });
  await click(root.findAll((node) => node.type === 'button' && text(node).trim() === '중지')[0]);
  await click(button(root, '확인:중지'));
  expect(client.request).toHaveBeenLastCalledWith({ action: 'component', componentId: 'apk', enabled: false });
});

it('changes the channel without installing anything', async () => {
  const client = fakeClient(status());
  const root = await mount(client);
  expect(text(root)).toContain('바꿔도 바로 설치되지 않아요');
  const beta = root.find((node) => node.props.role === 'radio' && text(node).startsWith('베타'));
  await act(async () => beta.props.onClick());
  expect(client.request).toHaveBeenCalledWith({ action: 'channel', channel: 'beta' });
});

it('explains how to enable management when the helper is missing', async () => {
  const unavailable = await mount(fakeClient(status({ available: false, reason: 'updater_unconfigured' })));
  expect(text(unavailable)).toContain('서버 관리 도구가 설정돼 있지 않아요');
  expect(text(unavailable)).toContain('boaa-updater');
  act(() => renderer?.unmount());

  const old = await mount(fakeClient(new ServerManagementError('unsupported', 'Not Found')));
  expect(text(old)).toContain('서버 관리 도구가 설정돼 있지 않아요');
  act(() => renderer?.unmount());

  const stopped = await mount(fakeClient(status({ available: false, reason: 'updater_unavailable' })));
  expect(text(stopped)).toContain('updater가 응답하지 않아요');
  expect(text(stopped)).not.toContain('설정돼 있지 않아요');
  act(() => renderer?.unmount());

  const drift = await mount(fakeClient(status({ available: false, reason: 'deployment_drift' })));
  expect(text(drift)).toContain('배포 구성이 저장된 상태와 달라요');
  expect(text(drift)).toContain('운영과 복구’ 절차');
  act(() => renderer?.unmount());

  const unknown = await mount(fakeClient(status({ available: false, reason: 'some_new_code' })));
  expect(text(unknown)).not.toContain('some_new_code');
  act(() => renderer?.unmount());

  const recovery = await mount(
    fakeClient(status({ available: false, phase: 'recovery-required', reason: 'update_recovery_required' })),
  );
  expect(text(recovery)).toContain('서버 복구가 필요해요');
  expect(text(recovery)).not.toContain('서버 관리 도구가 설정돼 있지 않아요');
  act(() => renderer?.unmount());

  const forbidden = await mount(fakeClient(new ServerManagementError('forbidden', 'Forbidden')));
  expect(text(forbidden)).toContain('서버 관리자만 볼 수 있어요');
});

it('keeps reconnecting while the update restarts the server, then offers a reload', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status({ release: { version: '99.0.0', publishedAt: '', notes: '', url: '' } }), false);
  const root = await mount(client);
  await click(button(root, '업데이트'));
  client.set(new ServerManagementError('offline', 'Failed to fetch'));
  await click(button(root, '확인:업데이트'));
  expect(text(root)).toContain('서버를 다시 시작하는 중이에요');

  const at = new Date().toISOString();
  client.set(
    status({
      currentVersion: '99.0.0',
      phase: 'complete',
      operation: { id: 'r1', action: 'update', startedAt: at, completedAt: at },
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100);
  });
  expect(text(root)).toContain('v99.0.0 업데이트를 마쳤어요');
  expect(text(root)).toContain('새로 고침');
});

it('keeps following an accepted request while GET still shows the previous idle state', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status(), false);
  const root = await mount(client);
  await click(button(root, '설치'));
  await click(button(root, '확인:설치'));
  expect(client.request).toHaveBeenCalledWith({ action: 'component', componentId: 'apk', enabled: true });
  // The updater has not picked the request up yet: still idle, previous operation id.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100);
  });
  expect(client.status.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(text(root)).toContain('요청 보냄');
  expect(text(root)).toContain('updater가 요청을 받으면 시작해요');

  const started = new Date().toISOString();
  client.set(
    status({
      busy: true,
      phase: 'downloading',
      operation: { id: 'r1', action: 'component', componentId: 'apk', enabled: true, startedAt: started },
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  expect(text(root)).toContain('설치 중');

  // The API restarts while the runtime is applied.
  client.set(new ServerManagementError('offline', 'Failed to fetch'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  expect(text(root)).toContain('서버가 잠시 다시 시작돼요');

  const at = new Date().toISOString();
  client.set(
    status({
      operationResults: [
        {
          id: 'r1',
          action: 'component',
          componentId: 'apk',
          enabled: true,
          startedAt: at,
          completedAt: at,
          outcome: 'complete',
        },
      ],
      components: [component({ id: 'apk', installed: true, enabled: true, running: true })],
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100);
  });
  expect(text(root)).toContain('APK 확장 실행기사용 중');
  expect(text(root)).not.toContain('다시 시작돼요');
  const calls = client.status.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(client.status.mock.calls.length).toBe(calls);
});

it('reports an expired request from the result history', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status(), false);
  const root = await mount(client);
  await click(button(root, '설치'));
  await click(button(root, '확인:설치'));
  const at = new Date().toISOString();
  client.set(
    status({
      operationResults: [
        {
          id: 'r1',
          action: 'component',
          componentId: 'apk',
          enabled: true,
          startedAt: at,
          completedAt: at,
          outcome: 'failed',
          error: 'management_request_expired',
        },
      ],
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  expect(text(root)).toContain('만료됐어요');
  expect(text(root)).not.toContain('management_request_expired');
  expect(button(root, '설치').props.disabled).toBe(false);
});

it('releases a request nobody reports on without claiming success or failure', async () => {
  vi.useFakeTimers();
  // Another operation ran and finished; ours never shows up in the current operation or the history.
  const at = new Date().toISOString();
  const client = fakeClient(
    status({ operation: { id: 'other', action: 'check', startedAt: at, completedAt: at }, operationResults: [] }),
    false,
  );
  const root = await mount(client);
  await click(button(root, '설치'));
  await click(button(root, '확인:설치'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(text(root)).toContain('요청 보냄');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(text(root)).toContain('요청 결과를 확인하지 못했어요');
  expect(text(root)).not.toContain('설치 중');
  expect(text(root)).not.toContain('못했어요. 다시 시도');
  expect(button(root, '설치').props.disabled).toBe(false);
  const calls = client.status.mock.calls.length;
  await click(button(root, '다시 확인'));
  expect(client.status.mock.calls.length).toBe(calls + 1);
});

it('does not stay busy when the server reports an active phase without busy', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status({ phase: 'applying', busy: false }));
  const root = await mount(client);
  expect(text(root)).not.toContain('새 버전으로 바꾸고 있어요');
  expect(button(root, '업데이트 확인').props.disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(client.status).toHaveBeenCalledTimes(1);
});

it('reports a failed tracked request', async () => {
  const client = fakeClient(status(), false);
  client.request.mockImplementationOnce(async () => {
    const at = new Date().toISOString();
    client.set(
      status({
        phase: 'failed',
        operationResults: [
          { id: 'r9', action: 'channel', startedAt: at, completedAt: at, outcome: 'failed', error: 'x_unknown' },
        ],
      }),
    );
    return { id: 'r9' };
  });
  const root = await mount(client);
  const beta = root.find((node) => node.props.role === 'radio' && text(node).startsWith('베타'));
  await act(async () => beta.props.onClick());
  expect(text(root)).toContain('버전 확인을 마치지 못했어요');
  expect(text(root)).not.toContain('바꾸지 못했어요');
  expect(text(root)).not.toContain('x_unknown');
});

it('maps HTTP failures to management errors', async () => {
  const api = { request: vi.fn().mockRejectedValue(new RemoteApiError('Not Found', 404)) };
  await expect(new ServerManagementClient(api).status()).rejects.toMatchObject({ kind: 'unsupported' });
  api.request.mockRejectedValue(new RemoteApiError('Forbidden', 403));
  await expect(new ServerManagementClient(api).status()).rejects.toMatchObject({ kind: 'forbidden' });
  api.request.mockRejectedValue(new RemoteApiError('updater_unavailable', 503));
  await expect(new ServerManagementClient(api).request({ action: 'check' })).rejects.toMatchObject({
    kind: 'updater-unavailable',
  });
  api.request.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(new ServerManagementClient(api).request({ action: 'check' })).rejects.toMatchObject({ kind: 'offline' });
  api.request.mockResolvedValue({ accepted: true, id: 'req-1' });
  await expect(new ServerManagementClient(api).request({ action: 'channel', channel: 'beta' })).resolves.toEqual({
    id: 'req-1',
  });
  expect(api.request).toHaveBeenLastCalledWith(
    '/admin/system/requests',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'channel', channel: 'beta' }) }),
    expect.any(Number),
  );
});

it('offers server management only for server-hosted web pages', () => {
  const remoteApiClient = {};
  const runtime = (kind: string, extra: Record<string, unknown> = {}) =>
    ({
      platformRuntime: { kind },
      readerRuntime: { mode: 'remote', remoteApiClient },
      ...extra,
    }) as unknown as AppRuntime;
  expect(serverManagementApi(runtime('browser'))).toBe(remoteApiClient);
  expect(serverManagementApi(runtime('tauri-desktop'))).toBeUndefined();
  expect(serverManagementApi(runtime('browser', { product: { kind: 'local-static' } }))).toBeUndefined();
  expect(
    serverManagementApi({
      platformRuntime: { kind: 'browser' },
      readerRuntime: { mode: 'local' },
    } as unknown as AppRuntime),
  ).toBeUndefined();
  expect(serverManagementApi(undefined)).toBeUndefined();
});

it('refreshes slowly while idle so runtime health changes show up', async () => {
  vi.useFakeTimers();
  const client = fakeClient(
    status({
      components: [
        component({
          id: 'metadata',
          installed: true,
          enabled: true,
          running: true,
          error: 'component_provider_missing',
        }),
      ],
    }),
  );
  const root = await mount(client);
  expect(text(root)).toContain('설정 필요');
  client.set(status({ components: [component({ id: 'metadata', installed: true, enabled: true, running: true })] }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(client.status).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_100);
  });
  expect(client.status).toHaveBeenCalledTimes(2);
  expect(text(root)).toContain('작품 정보 수집기사용 중');
});

it('blocks every change while the server needs recovery', async () => {
  const client = fakeClient(
    status({ phase: 'recovery-required', release: { version: '99.0.0', publishedAt: '', notes: '', url: '' } }),
  );
  const root = await mount(client);
  expect(text(root)).toContain('복구가 끝날 때까지 업데이트와 추가 기능 변경을');
  for (const label of ['업데이트', '업데이트 확인', '설치', '중지', '켜기'])
    expect(button(root, label).props.disabled).toBe(true);
  expect(root.findAll((node) => node.props.role === 'radiogroup')[0].props['aria-label']).toBe('받을 버전');
  expect(root.findAll((node) => node.props.role === 'radio').every((node) => node.props.disabled === true)).toBe(true);
});

it('does not credit an unconfirmed update with a version change it cannot prove', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status({ release: { version: '99.0.0', publishedAt: '', notes: '', url: '' } }), false);
  const root = await mount(client);
  await click(button(root, '업데이트'));
  await click(button(root, '확인:업데이트'));
  // Someone else moved the server to a new version; our request id never appears.
  client.set(status({ currentVersion: '99.0.0', operationResults: [] }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32_000);
  });
  expect(text(root)).toContain('요청 결과를 확인하지 못했어요');
  expect(text(root)).not.toContain('업데이트를 마쳤어요');
  // The version difference itself is still shown, as a reload prompt.
  expect(text(root)).toContain('서버와 버전이 달라요');
});

it('does not call the server current when the last check failed', async () => {
  const earlier = new Date(Date.now() - 3_600_000).toISOString();
  const at = new Date().toISOString();
  const fromPhase = await mount(
    fakeClient(
      status({
        checkedAt: earlier,
        phase: 'failed',
        error: 'release_manifest_invalid',
        operation: { id: 'c1', action: 'check', startedAt: at, completedAt: at },
      }),
    ),
  );
  expect(text(fromPhase)).toContain('새 버전을 확인하지 못했어요');
  expect(text(fromPhase)).toContain('최신인지는 아직 몰라요');
  expect(text(fromPhase)).not.toContain('최신 버전이에요');
  expect(text(fromPhase)).not.toContain('release_manifest_invalid');
  act(() => renderer?.unmount());

  const fromHistory = await mount(
    fakeClient(
      status({
        checkedAt: earlier,
        operationResults: [
          {
            id: 'c2',
            action: 'check',
            startedAt: at,
            completedAt: at,
            outcome: 'failed',
            error: 'release_rate_limited',
          },
          { id: 'c1', action: 'check', startedAt: earlier, completedAt: earlier, outcome: 'complete' },
        ],
      }),
    ),
  );
  expect(text(fromHistory)).toContain('새 버전을 확인하지 못했어요');
  expect(text(fromHistory)).not.toContain('최신 버전이에요');
  act(() => renderer?.unmount());

  const succeeded = await mount(
    fakeClient(
      status({
        operationResults: [
          { id: 'c3', action: 'check', startedAt: at, completedAt: at, outcome: 'complete' },
          { id: 'c2', action: 'check', startedAt: earlier, completedAt: earlier, outcome: 'failed' },
        ],
      }),
    ),
  );
  expect(text(succeeded)).toContain('최신 버전이에요');
});

it('reaches the result when every status GET takes longer than the poll interval', async () => {
  vi.useFakeTimers();
  const client = fakeClient(status(), false);
  const respond = client.status.getMockImplementation()!;
  client.status.mockImplementation(
    (signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        globalThis.setTimeout(() => {
          if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
          else respond().then(resolve, reject);
        }, 2_000);
      }) as ReturnType<typeof respond>,
  );
  const root = await mount(client);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
  await click(button(root, '설치'));
  await click(button(root, '확인:설치'));
  const at = new Date().toISOString();
  client.set(
    status({
      operationResults: [
        {
          id: 'r1',
          action: 'component',
          componentId: 'apk',
          enabled: true,
          startedAt: at,
          completedAt: at,
          outcome: 'complete',
        },
      ],
      components: [component({ id: 'apk', installed: true, enabled: true, running: true })],
    }),
  );
  // One second at a time, so each poll tick re-renders and schedules the next one as it does in a browser.
  for (let second = 0; second < 8; second += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  expect(text(root)).toContain('APK 확장 실행기사용 중');
  expect(text(root)).not.toContain('요청 보냄');
});

it('offers separate browser downloads and switches without marking both engines active', async () => {
  const client = fakeClient(
    status({
      components: [
        component({
          id: 'browser',
          engine: 'camoufox',
          installed: true,
          enabled: true,
          running: true,
          installedEngines: ['camoufox'],
          browserChoices: [
            { engine: 'patchright', supported: true, downloadBytes: 100 * 1024 ** 2 },
            { engine: 'camoufox', supported: true, downloadBytes: 400 * 1024 ** 2 },
          ],
        }),
      ],
    }),
  );
  const root = await mount(client);
  expect(text(root)).toContain('브라우저 인증설치 안 됨');
  expect(text(root)).toContain('Camoufox (실험)사용 중');
  await click(button(root, '설치'));
  await click(button(root, '확인:설치'));
  expect(client.request).toHaveBeenLastCalledWith({
    action: 'component',
    componentId: 'browser',
    engine: 'patchright',
    enabled: true,
  });
});
