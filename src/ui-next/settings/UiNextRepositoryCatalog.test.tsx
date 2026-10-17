import type { ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoaaPackageManifestV1 } from '@boaa/extension-contracts/package';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from '../../extensions/packages/installed-extension-manager';
import type { InstalledPackageSummary } from '../../extensions/packages/package-install-store';
import type { RepositoryEntry, RepositoryRecord } from '../../extensions/packages/repository-contract';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { examplePackageManifest } from '../../test/extension-package-fixture';
import { UiNextRepositoryCatalog } from './UiNextRepositoryCatalog';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
type Props = ComponentProps<typeof UiNextRepositoryCatalog>;
function entry(id = 'org.example.catalog', overrides: Partial<RepositoryEntry> = {}): RepositoryEntry {
  return { id, name: id, version: '2.0.0', archive: 'fixture.boaaext', sha256: 'a'.repeat(64), ...overrides };
}
function repository(entries: readonly RepositoryEntry[] = [entry()]): RepositoryRecord {
  return {
    url: 'https://repo.example/index.json',
    revision: 4,
    index: { format: 'boaa.extension.repository', version: 1, name: '테스트 저장소', packages: entries },
  };
}
function installed(id: BoaaPackageManifestV1['extension']['id'], version: string): InstalledPackageSummary {
  const manifest = examplePackageManifest() as BoaaPackageManifestV1;
  return {
    id,
    revision: 2,
    enabled: true,
    publisherPin: '',
    updatedAt: '2026-10-01',
    active: { digest: 'installed', manifest: { ...manifest, extension: { ...manifest.extension, id, version } } },
  };
}
function fixture(repositories: readonly RepositoryRecord[] = [], packages: readonly InstalledPackageSummary[] = []) {
  const snapshot: InstalledExtensionsSnapshot = { available: true, revision: 1, packages, sources: [], errors: [] };
  const plan: PackageReview = {
    package: { digest: 'review-digest', manifest: examplePackageManifest() as BoaaPackageManifestV1 },
    expectedRevision: 0,
    operation: 'install',
    publisherChanged: false,
    downgrade: false,
    expandedAccess: false,
  };
  const review = { file: new File(['fixture'], 'example.boaaext'), plan };
  const manager: InstalledExtensionManager = {
    target: 'server',
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => snapshot),
    refresh: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn(),
    install: vi.fn(),
    change: vi.fn(),
    checkUpdate: vi.fn(),
    listRepositories: vi.fn().mockResolvedValue(repositories),
    refreshRepository: vi.fn().mockResolvedValue(repository()),
    removeRepository: vi.fn().mockResolvedValue(undefined),
    selectRepositoryPackage: vi.fn().mockResolvedValue(review),
    releaseCovers: vi.fn(),
    getExternalSources: vi.fn(() => []),
    getExternalSourceStatus: vi.fn(),
    connectExternalSource: vi.fn(),
    disconnectExternalSource: vi.fn(),
    listExternalSource: vi.fn(),
    downloadExternalSource: vi.fn(),
  };
  const props: Props = {
    manager,
    snapshot,
    disabled: false,
    renderReview: vi.fn(() => null),
    onReview: vi.fn(),
    onMangayomiRepository: vi.fn(),
    onApkRepository: vi.fn(),
  };
  return { props, manager, review };
}
async function mount(value = fixture()) {
  await act(async () => {
    renderer = create(<UiNextRepositoryCatalog {...value.props} />);
  });
  expect(value.manager.listRepositories).toHaveBeenCalledOnce();
  return { root: renderer!.root, ...value };
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
function row(root: ReactTestInstance, name: string) {
  return root.find(
    (node) => node.type === 'article' && node.findAllByType('strong').some((title) => text(title) === name),
  );
}
function change(root: ReactTestInstance, name: string, value: string) {
  act(() => root.findByProps({ 'aria-label': name }).props.onChange({ target: { value } }));
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}
async function submitRepository(root: ReactTestInstance, url: string) {
  change(root, '저장소 주소', url);
  expect(button(root, '추가').props.disabled).toBe(false);
  const preventDefault = vi.fn();
  await act(async () => {
    root.findByType('form').props.onSubmit({ preventDefault });
  });
  expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
}

describe('UiNextRepositoryCatalog repositories', () => {
  it('adds the address, reloads saved repositories, and selects the new catalogue', async () => {
    const { root, manager } = await mount();
    vi.mocked(manager.listRepositories!).mockResolvedValue([repository()]);
    await submitRepository(root, 'https://repo.example/index.json');
    expect(row(root, 'org.example.catalog')).toBeDefined();
    expect(manager.refreshRepository).toHaveBeenCalledExactlyOnceWith('https://repo.example/index.json');
    expect(root.findByProps({ role: 'tab' }).props['aria-selected']).toBe(true);
    expect(root.findByProps({ 'aria-label': '저장소 주소' }).props.value).toBe('');
  });
  it.each([
    ['package_repository_mangayomi', 'onMangayomiRepository'],
    ['package_repository_suwayomi', 'onApkRepository'],
  ] as const)('routes %s to %s without displaying an error', async (code, callback) => {
    const { root, manager, props } = await mount();
    vi.mocked(manager.refreshRepository!).mockRejectedValue(new Error(code));
    await submitRepository(root, 'https://compat.example/index.json');
    expect(props[callback]).toHaveBeenCalledExactlyOnceWith('https://compat.example/index.json');
    expect(root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(root.findByProps({ 'aria-label': '저장소 주소' }).props.value).toBe('');
  });
  it.each([
    ['package_repository_mangayomi', 'onMangayomiRepository'],
    ['package_repository_suwayomi', 'onApkRepository'],
  ] as const)('recognizes translated transport errors for %s', async (code, callback) => {
    const { root, manager, props } = await mount();
    vi.mocked(manager.refreshRepository!).mockRejectedValue(new Error(packageOperationMessage(new Error(code))!));
    await submitRepository(root, 'https://compat.example/index.json');
    expect(props[callback]).toHaveBeenCalledExactlyOnceWith('https://compat.example/index.json');
    expect(root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });
  it('displays an error for a failed repository request', async () => {
    const { root, manager } = await mount();
    vi.mocked(manager.refreshRepository!).mockRejectedValue(new Error('network offline'));
    await submitRepository(root, 'https://repo.example/index.json');
    expect(text(root.findByProps({ role: 'alert' }))).toContain('저장소를 불러오지 못했어요');
  });
  it('requires deletion confirmation and keeps installed packages after removal', async () => {
    const value = fixture([repository()], [installed('org.example.catalog', '2.0.0')]);
    const { root, manager, props } = await mount(value);
    await click(button(root, '저장소 삭제'));
    expect(text(root)).toContain('설치한 확장은 남아요.');
    expect(manager.removeRepository).not.toHaveBeenCalled();
    await click(button(root, '취소'));
    expect(buttons(root, '삭제')).toHaveLength(0);
    await click(button(root, '저장소 삭제'));
    vi.mocked(manager.listRepositories!).mockResolvedValue([]);
    await click(button(root, '삭제'));
    expect(manager.removeRepository).toHaveBeenCalledExactlyOnceWith('https://repo.example/index.json', 4);
    expect(text(root)).toContain('배포처에서 받은 저장소 주소');
    expect(manager.change).not.toHaveBeenCalled();
    expect(props.snapshot.packages).toHaveLength(1);
  });
});

describe('UiNextRepositoryCatalog package actions', () => {
  it.each([
    [undefined, '2.0.0', '받기', false],
    ['2.0.0', '2.0.0', '설치됨', true],
    ['2.0.0', '10.0.0', '업데이트', false],
    ['10.0.0', '2.0.0', '설치됨', true],
  ] as const)('compares installed %s with catalogue %s as %s', async (local, version, label, disabled) => {
    const id = 'org.example.catalog';
    const { root, manager, props, review } = await mount(
      fixture([repository([entry(id, { name: '패키지', version })])], local ? [installed(id, local)] : []),
    );
    const action = button(row(root, '패키지'), label);
    expect(action.props.disabled).toBe(disabled);
    if (disabled) expect(manager.selectRepositoryPackage).not.toHaveBeenCalled();
    else {
      await click(action);
      expect(props.onReview).toHaveBeenCalledExactlyOnceWith(review);
      expect(manager.selectRepositoryPackage).toHaveBeenCalledExactlyOnceWith(
        'https://repo.example/index.json',
        id,
        'a'.repeat(64),
      );
    }
  });
  it.each(['업데이트', 'ORG.EXAMPLE.UPDATE', '새로운 설명'])(
    'searches case-insensitive name, id, and description (%s)',
    async (query) => {
      const { root } = await mount(
        fixture([
          repository([
            entry('org.example.update', { name: '업데이트 후보', description: '새로운 설명' }),
            entry('org.example.other', { name: '다른 확장' }),
          ]),
        ]),
      );
      change(root, '확장 검색', ` ${query} `);
      expect(root.findAllByType('article')).toHaveLength(1);
      expect(row(root, '업데이트 후보')).toBeDefined();
    },
  );
  it('toggles updates-only filtering and combines it with search', async () => {
    const { root } = await mount(
      fixture(
        [
          repository([
            entry('org.example.update', { name: '업데이트 후보' }),
            entry('org.example.current', { name: '설치한 확장' }),
            entry('org.example.new', { name: '새 확장' }),
          ]),
        ],
        [installed('org.example.update', '1.0.0'), installed('org.example.current', '2.0.0')],
      ),
    );
    const filter = button(root, /업데이트만/);
    await click(filter);
    expect(filter.props['aria-pressed']).toBe(true);
    expect(root.findAllByType('article')).toHaveLength(1);
    expect(row(root, '업데이트 후보')).toBeDefined();
    change(root, '확장 검색', '새 확장');
    expect(text(root)).toContain('조건에 맞는 확장이 없어요.');
    await click(filter);
    expect(filter.props['aria-pressed']).toBe(false);
    expect(row(root, '새 확장')).toBeDefined();
  });
  it('reveals thirty more entries at a time and resets pagination on search', async () => {
    const entries = Array.from({ length: 65 }, (_, index) =>
      entry(`org.example.pkg${index}`, { name: `패키지 ${index + 1}` }),
    );
    const { root } = await mount(fixture([repository(entries)]));
    expect(root.findAllByType('article')).toHaveLength(30);
    await click(button(root, '35개 더 보기'));
    expect(root.findAllByType('article')).toHaveLength(60);
    await click(button(root, '5개 더 보기'));
    expect(root.findAllByType('article')).toHaveLength(65);
    expect(buttons(root, /개 더 보기$/)).toHaveLength(0);
    change(root, '확장 검색', '패키지');
    expect(root.findAllByType('article')).toHaveLength(30);
    expect(button(root, '35개 더 보기')).toBeDefined();
  });
});
