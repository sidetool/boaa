import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveSourceReadingPreferences,
  sourceReadingDefaults,
  sourceReadingPreferences,
  type SourceReadingPreferences,
} from '../../external-sources/source-reading-preferences';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import { RuntimeProvider } from '../../app/runtime/RuntimeProvider';
import type { AppRuntime } from '../../app/runtime/app-runtime';
import { UiNextSourceReadingSettings } from './UiNextSourceReadingSettings';

vi.mock('../../external-sources/source-reading-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../external-sources/source-reading-preferences')>()),
  sourceReadingPreferences: vi.fn(),
  saveSourceReadingPreferences: vi.fn(),
}));
let renderer: ReactTestRenderer | undefined;
let stored: SourceReadingPreferences;
beforeEach(() => {
  vi.resetAllMocks();
  stored = { ...sourceReadingDefaults };
  vi.mocked(sourceReadingPreferences).mockImplementation(() => ({ ...stored }));
  vi.mocked(saveSourceReadingPreferences).mockImplementation((patch) => {
    stored = { ...stored, ...patch };
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function controller(overrides: Partial<ExternalSourceController> = {}): ExternalSourceController {
  // Only the settings and recovery ports are consumed here; the source screen tests cover the full controller.
  const value: Partial<ExternalSourceController> = {
    busy: false,
    recoverableDownloads: [],
    autoDownloadNext: false,
    autoDownloadNextCount: 1,
    setAutoDownloadNext: vi.fn(),
    setAutoDownloadNextCount: vi.fn(),
    ...overrides,
  };
  return value as ExternalSourceController;
}
function retention(
  overrides: Partial<NonNullable<ExternalSourceController['downloadRetention']>> = {},
): NonNullable<ExternalSourceController['downloadRetention']> {
  return {
    enabled: true,
    keep: 5,
    busy: false,
    readerActive: false,
    error: '',
    setEnabled: vi.fn(),
    setKeep: vi.fn(),
    inspect: vi.fn().mockResolvedValue(undefined),
    clean: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function mount(value = controller()) {
  act(() => {
    renderer = create(<UiNextSourceReadingSettings controller={value} />);
  });
  return { root: renderer!.root, controller: value };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function group(root: ReactTestInstance, name: string) {
  return root.findByProps({ role: 'radiogroup', 'aria-label': name });
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

describe('UiNextSourceReadingSettings opening and prefetch preferences', () => {
  it.each([
    ['서재에 저장해서 읽기', 'library'],
    ['바로 읽기', 'stream'],
  ] as const)('saves text mode %s', (label, textMode) => {
    const { root } = mount();
    click(button(group(root, '소설 회차 열기'), label));
    expect(saveSourceReadingPreferences).toHaveBeenCalledExactlyOnceWith({ textMode }, undefined);
    expect(button(group(root, '소설 회차 열기'), label).props['aria-checked']).toBe(true);
  });
  it.each([
    ['바로 보기', 'stream'],
    ['보면서 저장', 'stream-save'],
    ['받은 뒤 보기', 'download'],
  ] as const)('saves comic mode %s', (label, mode) => {
    const { root } = mount();
    click(button(group(root, '만화·웹툰 회차 열기'), label));
    expect(saveSourceReadingPreferences).toHaveBeenCalledExactlyOnceWith({ mode }, undefined);
    expect(button(group(root, '만화·웹툰 회차 열기'), label).props['aria-checked']).toBe(true);
  });
  it.each([0, 2, 4, 5, 8, 10] as const)('saves image prefetch %s', (prefetch) => {
    const { root } = mount();
    const label = prefetch === 0 ? '끔' : `${prefetch}장`;
    click(button(group(root, '이미지 미리 불러오기'), label));
    expect(saveSourceReadingPreferences).toHaveBeenCalledExactlyOnceWith({ prefetch }, undefined);
    expect(button(group(root, '이미지 미리 불러오기'), label).props['aria-checked']).toBe(true);
  });
  it('reports preference save failures and keeps the previous choice', () => {
    vi.mocked(saveSourceReadingPreferences).mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const { root } = mount();
    click(button(group(root, '소설 회차 열기'), '바로 읽기'));
    expect(text(root.findByProps({ role: 'alert' }))).toContain('설정을 저장하지 못했어요');
    expect(button(group(root, '소설 회차 열기'), '서재에 저장해서 읽기').props['aria-checked']).toBe(true);
  });
});

describe('UiNextSourceReadingSettings download policy', () => {
  it.each([false, true])('toggles pre-downloading from %s and only shows its count when enabled', (enabled) => {
    const { root, controller: value } = mount(controller({ autoDownloadNext: enabled }));
    const toggle = root.findByProps({ role: 'switch', 'aria-label': '다음 회차 미리 받기' });
    expect(toggle.props['aria-checked']).toBe(enabled);
    expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': '미리 받을 회차 수' })).toHaveLength(
      enabled ? 1 : 0,
    );
    click(toggle);
    expect(value.setAutoDownloadNext).toHaveBeenCalledExactlyOnceWith(!enabled);
    expect(saveSourceReadingPreferences).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3] as const)('sets the next download count to %s', (count) => {
    const { root, controller: value } = mount(controller({ autoDownloadNext: true, autoDownloadNextCount: count }));
    const choice = button(group(root, '미리 받을 회차 수'), `${count}화`);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(value.setAutoDownloadNextCount).toHaveBeenCalledExactlyOnceWith(count);
  });
  it('omits retention controls when no retention controller exists', () => {
    const { root } = mount();
    expect(root.findAllByProps({ role: 'switch', 'aria-label': '읽은 회차 자동 정리' })).toHaveLength(0);
    expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': '정리 전 더 읽을 회차 수' })).toHaveLength(0);
  });
  it.each([false, true])('toggles retention from %s and only shows its count when enabled', (enabled) => {
    const policy = retention({ enabled });
    const { root } = mount(controller({ downloadRetention: policy }));
    const toggle = root.findByProps({ role: 'switch', 'aria-label': '읽은 회차 자동 정리' });
    expect(toggle.props['aria-checked']).toBe(enabled);
    expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': '정리 전 더 읽을 회차 수' })).toHaveLength(
      enabled ? 1 : 0,
    );
    click(toggle);
    expect(policy.setEnabled).toHaveBeenCalledExactlyOnceWith(!enabled);
  });
  it.each([5, 10, 20] as const)('sets retention keep count to %s', (keep) => {
    const policy = retention({ keep });
    const { root } = mount(controller({ downloadRetention: policy }));
    const choice = button(group(root, '정리 전 더 읽을 회차 수'), `${keep}화`);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(policy.setKeep).toHaveBeenCalledExactlyOnceWith(keep);
  });
  it('does not change retention policy while busy', () => {
    const policy = retention({ busy: true });
    const { root } = mount(controller({ downloadRetention: policy }));
    click(root.findByProps({ role: 'switch', 'aria-label': '읽은 회차 자동 정리' }));
    click(button(group(root, '정리 전 더 읽을 회차 수'), '10화'));
    expect(policy.setEnabled).not.toHaveBeenCalled();
    expect(policy.setKeep).not.toHaveBeenCalled();
  });
});

describe('UiNextSourceReadingSettings cache fold', () => {
  it.each([
    ['목록·작품 정보 재사용 시간', '안 함', { listMinutes: 0 }],
    ['목록·작품 정보 재사용 시간', '2분', { listMinutes: 2 }],
    ['목록·작품 정보 재사용 시간', '30분', { listMinutes: 30 }],
    ['목록·작품 정보 재사용 시간', '6시간', { listMinutes: 360 }],
    ['표지 이미지 재사용 시간', '안 함', { coverHours: 0 }],
    ['표지 이미지 재사용 시간', '1시간', { coverHours: 1 }],
    ['표지 이미지 재사용 시간', '1일', { coverHours: 24 }],
    ['표지 이미지 재사용 시간', '1주', { coverHours: 168 }],
    ['보는 이미지 임시 보관 시간', '안 함', { imageMinutes: 0 }],
    ['보는 이미지 임시 보관 시간', '2분', { imageMinutes: 2 }],
    ['보는 이미지 임시 보관 시간', '10분', { imageMinutes: 10 }],
  ] as const)('saves %s / %s', (name, label, patch) => {
    const { root } = mount();
    const fold = root.findByType('details');
    expect(text(fold.findByType('summary'))).toContain('캐시');
    click(button(group(fold, name), label));
    expect(saveSourceReadingPreferences).toHaveBeenCalledExactlyOnceWith(patch, undefined);
    expect(button(group(fold, name), label).props['aria-checked']).toBe(true);
  });
});

describe('UiNextSourceReadingSettings account scope', () => {
  it('reads and saves a hosted account’s own preferences, never the device-wide key', () => {
    const runtime = {
      readerRuntime: { session: { storageScope: 'hosted-account:synthetic' } },
    } as unknown as AppRuntime;
    act(() => {
      renderer = create(
        <RuntimeProvider runtime={runtime}>
          <UiNextSourceReadingSettings controller={controller()} />
        </RuntimeProvider>,
      );
    });
    expect(
      vi.mocked(sourceReadingPreferences).mock.calls.every(([scope]) => scope === 'hosted-account:synthetic'),
    ).toBe(true);
    click(button(group(renderer!.root, '소설 회차 열기'), '바로 읽기'));
    expect(saveSourceReadingPreferences).toHaveBeenCalledExactlyOnceWith(
      { textMode: 'stream' },
      'hosted-account:synthetic',
    );
  });
});
