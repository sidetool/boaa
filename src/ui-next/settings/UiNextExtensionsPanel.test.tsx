import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoaaPackageManifestV1 } from '@boaa/extension-contracts/package';
import type { ApkExtensionManager } from '../../extensions/packages/apk-extension-manager';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from '../../extensions/packages/installed-extension-manager';
import type { InstalledPackageSummary } from '../../extensions/packages/package-install-store';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import { UiNextExtensionsPanel } from './UiNextExtensionsPanel';

const capability = vi.hoisted(() => ({ manageExtensions: true }));
vi.mock('../../features/auth/self-host-account-api', () => ({
  useSelfHostCapability: (name: string) => (name === 'manageExtensions' ? capability.manageExtensions : true),
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});
function plan(overrides: Partial<PackageReview> = {}): PackageReview {
  return {
    package: { digest: 'fixture-digest', manifest: examplePackageManifest() as BoaaPackageManifestV1 },
    expectedRevision: 0,
    operation: 'install',
    publisherChanged: false,
    expandedAccess: false,
    downgrade: false,
    ...overrides,
  };
}
function installed(): InstalledPackageSummary {
  return {
    id: 'org.example.catalog',
    revision: 7,
    enabled: true,
    publisherPin: '',
    updatedAt: '2026-10-01',
    active: plan().package,
  };
}
function compatibility(): ApkExtensionManager {
  return {
    list: vi.fn().mockResolvedValue({ available: true, revision: 1, packages: [], repositories: [] }),
    refreshRepository: vi.fn().mockResolvedValue(undefined),
    removeRepository: vi.fn().mockResolvedValue(undefined),
    inspectRepository: vi.fn(),
    install: vi.fn(),
    change: vi.fn(),
  };
}
function fixture(overrides: Partial<InstalledExtensionsSnapshot> = {}) {
  let snapshot: InstalledExtensionsSnapshot = {
    available: true,
    revision: 1,
    packages: [],
    sources: [],
    errors: [],
    ...overrides,
  };
  const listeners = new Set<() => void>();
  const manager: InstalledExtensionManager = {
    target: 'server',
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    getSnapshot: vi.fn(() => snapshot),
    refresh: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(plan()),
    install: vi.fn().mockResolvedValue(undefined),
    change: vi.fn().mockResolvedValue(undefined),
    checkUpdate: vi.fn().mockResolvedValue(undefined),
    listRepositories: vi.fn().mockResolvedValue([]),
    refreshRepository: vi.fn(),
    removeRepository: vi.fn(),
    selectRepositoryPackage: vi.fn(),
    releaseCovers: vi.fn(),
    getExternalSources: vi.fn(() => []),
    getExternalSourceStatus: vi.fn(),
    connectExternalSource: vi.fn(),
    disconnectExternalSource: vi.fn(),
    listExternalSource: vi.fn(),
    downloadExternalSource: vi.fn(),
  };
  return {
    manager,
    publish(next: Partial<InstalledExtensionsSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 };
        listeners.forEach((listener) => listener());
      });
    },
  };
}
async function mount(
  manager: InstalledExtensionManager,
  overrides: Partial<ComponentProps<typeof UiNextExtensionsPanel>> = {},
) {
  await act(async () => {
    renderer = create(<UiNextExtensionsPanel manager={manager} {...overrides} />);
  });
  return renderer!.root;
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function buttons(root: ReactTestInstance, name: string | RegExp) {
  return root.findAll((node) => {
    if (node.type !== 'button') return false;
    const label = node.props['aria-label'] ?? text(node).replace(/\s+/g, ' ').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
}
function button(root: ReactTestInstance, name: string | RegExp) {
  const matches = buttons(root, name);
  expect(matches).toHaveLength(1);
  return matches[0];
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}
function tab(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && node.props.role === 'radio' && text(node).trim() === name);
}
async function checkUpdates() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
async function inspect(root: ReactTestInstance, manager: InstalledExtensionManager, review = plan()) {
  vi.mocked(manager.inspect).mockResolvedValue(review);
  const file = new File(['fixture'], 'example.boaaext');
  const input = { files: [file], value: 'example.boaaext' };
  await act(async () => {
    root.findByProps({ 'aria-label': '확장 패키지 파일' }).props.onChange({ currentTarget: input });
  });
  expect(input.value).toBe('');
  const card = root.findByProps({ 'aria-label': '확장 설치 확인' });
  expect(manager.inspect).toHaveBeenCalledExactlyOnceWith(file, expect.any(AbortSignal));
  return { file, card };
}

describe('UiNextExtensionsPanel installed list', () => {
  it('opens the add tab from the empty-state action', async () => {
    const { manager } = fixture();
    const root = await mount(manager);
    expect(text(root)).toContain('아직 설치한 확장이 없어요');
    await click(button(root, '확장 추가하기'));
    expect(tab(root, '추가하기').props['aria-checked']).toBe(true);
    expect(root.findByProps({ 'aria-label': '확장 저장소' })).toBeDefined();
    expect(text(root)).not.toContain('아직 설치한 확장이 없어요');
  });
  it('shows name and version and disables a package through its switch', async () => {
    const { manager } = fixture({ packages: [installed()] });
    const root = await mount(manager);
    expect(text(root)).toContain('예제 소스');
    expect(text(root)).toContain('v1.0.0');
    const toggle = root.findByProps({ role: 'switch', 'aria-label': '예제 소스 사용' });
    expect(toggle.props['aria-checked']).toBe(true);
    await click(toggle);
    expect(manager.change).toHaveBeenCalledExactlyOnceWith('org.example.catalog', 7, 'disable');
  });
  it('requires explicit removal confirmation, and cancellation does not remove', async () => {
    const { manager } = fixture({ packages: [installed()] });
    const root = await mount(manager);
    await click(button(root, /예제 소스.*v1.0.0/));
    await click(button(root, '제거…'));
    expect(manager.change).not.toHaveBeenCalled();
    expect(text(root)).toContain('받은 작품은 그대로 남아요.');
    await click(button(root, '취소'));
    expect(buttons(root, '제거')).toHaveLength(0);
    expect(manager.change).not.toHaveBeenCalled();
    await click(button(root, '제거…'));
    await click(button(root, '제거'));
    expect(manager.change).toHaveBeenCalledExactlyOnceWith('org.example.catalog', 7, 'remove');
  });
  it('refreshes the inventory and observes manager subscription updates', async () => {
    const { manager, publish } = fixture();
    const root = await mount(manager);
    await click(button(root, '설치된 확장 새로고침'));
    expect(manager.refresh).toHaveBeenCalledExactlyOnceWith();
    publish({ packages: [installed()] });
    expect(root.findByProps({ role: 'switch', 'aria-label': '예제 소스 사용' })).toBeDefined();
    expect(text(root)).not.toContain('아직 설치한 확장이 없어요');
  });
});

describe('UiNextExtensionsPanel file review', () => {
  it('inspects a file, displays unsigned permissions, and installs the reviewed plan', async () => {
    const { manager } = fixture();
    const root = await mount(manager);
    const review = plan();
    const { file, card } = await inspect(root, manager, review);
    for (const label of [
      '예제 소스',
      '외부 작품 검색과 목록 조회',
      '선택한 작품의 회차 가져오기',
      'https://catalog.example',
      '서명이 없는 파일이에요',
    ])
      expect(text(card)).toContain(label);
    expect(manager.install).not.toHaveBeenCalled();
    await click(button(card, '설치'));
    expect(manager.install).toHaveBeenCalledExactlyOnceWith(file, review, expect.any(AbortSignal));
    expect(root.findAllByProps({ 'aria-label': '확장 설치 확인' })).toHaveLength(0);
    expect(tab(root, '설치됨').props['aria-checked']).toBe(true);
    expect(text(root)).toContain('설치했어요. 탐색에서 바로');
  });
  it.each(['publisherChanged', 'downgrade'] as const)(
    'requires acknowledgement of %s before installing',
    async (kind) => {
      const { manager } = fixture();
      const root = await mount(manager);
      const review = plan({ [kind]: true });
      const { file, card } = await inspect(root, manager, review);
      expect(button(card, '설치').props.disabled).toBe(true);
      expect(manager.install).not.toHaveBeenCalled();
      const acknowledgement = card.findByType('label');
      expect(text(acknowledgement)).toContain('위 변경 사항을 확인했어요');
      act(() => acknowledgement.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
      expect(button(card, '설치').props.disabled).toBe(false);
      await click(button(card, '설치'));
      expect(manager.install).toHaveBeenCalledExactlyOnceWith(file, review, expect.any(AbortSignal));
    },
  );
});

describe('UiNextExtensionsPanel navigation', () => {
  it('opens updates immediately for a notification request', async () => {
    const { manager } = fixture();
    const root = await mount(manager, { updatesRequest: 1 });
    expect(tab(root, '업데이트').props['aria-checked']).toBe(true);
    expect(root.findByProps({ 'aria-label': '소스 업데이트' })).toBeDefined();
    await checkUpdates();
    expect(text(root)).toContain('새 업데이트가 없습니다.');
  });
  it('opens updates again when a request arrives while already mounted', async () => {
    const { manager } = fixture();
    const root = await mount(manager);
    await act(async () => {
      renderer!.update(<UiNextExtensionsPanel manager={manager} updatesRequest={1} />);
    });
    expect(tab(root, '업데이트').props['aria-checked']).toBe(true);
    await checkUpdates();
    expect(text(root)).toContain('새 업데이트가 없습니다.');
    await click(tab(root, '설치됨'));
    await act(async () => {
      renderer!.update(<UiNextExtensionsPanel manager={manager} updatesRequest={2} />);
    });
    expect(root.findByProps({ 'aria-label': '소스 업데이트' })).toBeDefined();
    await checkUpdates();
    expect(text(root)).toContain('새 업데이트가 없습니다.');
  });
  it.each(['none', 'mangayomi', 'apk', 'both'] as const)(
    'shows compatibility links only for installed source kinds (%s)',
    async (kind) => {
      const descriptor = (examplePackageManifest() as BoaaPackageManifestV1).extension.contributes!.externalSources![0];
      const { manager } = fixture({
        sources: [
          ...(kind === 'mangayomi' || kind === 'both' ? [{ descriptor, mangayomiPackageId: 'example.js' }] : []),
          ...(kind === 'apk' || kind === 'both' ? [{ descriptor, apkPackageId: 'org.example.apk' }] : []),
          { descriptor },
        ],
      });
      const root = await mount({ ...manager, mangayomi: compatibility(), apk: compatibility() });
      expect(buttons(root, /Mangayomi JS 확장소스/)).toHaveLength(kind === 'mangayomi' || kind === 'both' ? 1 : 0);
      expect(buttons(root, /APK 확장소스/)).toHaveLength(kind === 'apk' || kind === 'both' ? 1 : 0);
      if (kind === 'mangayomi' || kind === 'apk') {
        await click(button(root, kind === 'apk' ? /APK 확장소스/ : /Mangayomi JS 확장소스/));
        const region = root.findByProps({ 'aria-label': kind === 'apk' ? 'APK 확장 관리' : 'Mangayomi JS 확장 관리' });
        expect(button(region, '설치됨 0').props['aria-pressed']).toBe(true);
      }
    },
  );
});

describe('UiNextExtensionsPanel for a member account', () => {
  afterEach(() => {
    capability.manageExtensions = true;
  });
  it('lets a member use and sign in to allowed sources without install, update, removal or network controls', async () => {
    capability.manageExtensions = false;
    const { manager } = fixture({ packages: [installed()] });
    const root = await mount(manager);
    expect(text(root)).toContain('관리자가 허용한 소스');
    expect(buttons(root, /파일로 설치/)).toHaveLength(0);
    expect(root.findAll((node) => node.props.role === 'radio' && text(node).trim() === '추가하기')).toHaveLength(0);
    expect(root.findAll((node) => node.type === 'details')).toHaveLength(0);
    await click(buttons(root, /Example/)[0] ?? root.find((node) => node.props['aria-expanded'] === false));
    expect(buttons(root, /제거/)).toHaveLength(0);
    expect(buttons(root, '업데이트 확인')).toHaveLength(0);
  });
});
