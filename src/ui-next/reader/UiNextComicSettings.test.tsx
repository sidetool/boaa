import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComicReadingProfile } from '../../domain/types';
import { DEFAULT_COMIC_READING_PROFILE } from '../../features/fixed-document/comic-layout';
import { SettingsSlider } from '../../features/reader-settings/SettingsSlider';
import { UiNextComicSettings, type UiNextComicSettingsProps } from './UiNextComicSettings';

type Props = UiNextComicSettingsProps;
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function fixture(overrides: Partial<Props> = {}, profile: Partial<ComicReadingProfile> = {}): Props {
  return {
    viewMode: 'single',
    profile: { ...DEFAULT_COMIC_READING_PROFILE, ...profile },
    narrow: false,
    pageIndex: 2,
    totalPages: 4,
    crop: { status: 'idle', failedPages: 0, run: vi.fn(), cancel: vi.fn() },
    onViewMode: vi.fn(),
    onFit: vi.fn(),
    update: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}
function mount(props = fixture()) {
  act(() => {
    renderer = create(<UiNextComicSettings {...props} />);
  });
  return { root: renderer!.root, props };
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
function group(root: ReactTestInstance, label: string) {
  return root.findByProps({ role: 'radiogroup', 'aria-label': label });
}
function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

describe('UiNextComicSettings layout', () => {
  it.each([
    ['single', '한 쪽'],
    ['spread', '두 쪽'],
    ['continuous', '세로 스크롤'],
    ['continuous-seamless', '웹툰'],
  ] as const)('selects view mode %s', (viewMode, label) => {
    const { root, props } = mount(fixture({ viewMode }));
    const modes = group(root, '보기 방식');
    expect(modes.findAllByProps({ role: 'radio' })).toHaveLength(4);
    expect(modes.findAllByProps({ 'aria-checked': true })).toHaveLength(1);
    expect(button(modes, label).props['aria-checked']).toBe(true);
    click(button(modes, label));
    expect(props.onViewMode).toHaveBeenCalledExactlyOnceWith(viewMode);
  });
  it.each(['single', 'spread', 'continuous', 'continuous-seamless'] as const)(
    'only shows relevant rows for %s',
    (viewMode) => {
      const { root } = mount(fixture({ viewMode }));
      for (const label of ['넘기는 방향', '페이지 전환'])
        expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': label })).toHaveLength(
          viewMode === 'single' || viewMode === 'spread' ? 1 : 0,
        );
      for (const label of ['표지', '첫 페이지 면'])
        expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': label })).toHaveLength(
          viewMode === 'spread' ? 1 : 0,
        );
      expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': '페이지 간격' })).toHaveLength(
        viewMode === 'continuous' ? 1 : 0,
      );
    },
  );
  it.each([
    ['전체', 'page'],
    ['너비', 'width'],
    ['높이', 'height'],
    ['원본', 'original'],
  ] as const)('routes fitting %s to onFit', (label, fit) => {
    const { root, props } = mount();
    click(button(group(root, '화면 맞춤'), label));
    expect(props.onFit).toHaveBeenCalledExactlyOnceWith(fit);
  });
  it.each([
    ['넘기는 방향', '왼쪽부터', { direction: 'ltr' }],
    ['넘기는 방향', '오른쪽부터 (만화)', { direction: 'rtl' }],
    ['페이지 전환', '없음', { pageTurnMotion: 'instant' }],
    ['페이지 전환', '밀기', { pageTurnMotion: 'slide' }],
    ['페이지 전환', '책장', { pageTurnMotion: 'page' }],
    ['표지', '단독', { coverBehavior: 'single' }],
    ['표지', '함께 펼침', { coverBehavior: 'paired' }],
    ['첫 페이지 면', '자동', { pageParity: 'auto' }],
    ['첫 페이지 면', '왼쪽', { pageParity: 'left' }],
    ['첫 페이지 면', '오른쪽', { pageParity: 'right' }],
  ] as const)('updates %s / %s', (name, label, patch) => {
    const { root, props } = mount(fixture({ viewMode: 'spread' }));
    click(button(group(root, name), label));
    expect(props.update).toHaveBeenCalledExactlyOnceWith(patch);
  });
  it.each([
    ['없음', 0],
    ['좁게', 8],
    ['넓게', 24],
  ] as const)('sets continuous gap %s as a number', (label, gap) => {
    const { root, props } = mount(fixture({ viewMode: 'continuous' }, { gap }));
    const choice = button(group(root, '페이지 간격'), label);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(props.update).toHaveBeenCalledExactlyOnceWith({ gap });
  });
  it.each([
    ['black', '검정'],
    ['charcoal', '짙은 회색'],
    ['white', '흰색'],
  ] as const)('selects background %s', (background, label) => {
    const { root, props } = mount(fixture({}, { background }));
    const backgrounds = group(root, '배경');
    expect(backgrounds.findAllByProps({ 'aria-checked': true })).toHaveLength(1);
    expect(button(backgrounds, label).props['aria-checked']).toBe(true);
    click(button(backgrounds, label));
    expect(props.update).toHaveBeenCalledExactlyOnceWith({ background });
  });
});

describe('UiNextComicSettings display correction', () => {
  it('omits reset when display correction is neutral', () => {
    const { root } = mount();
    expect(buttons(root, '초기화')).toHaveLength(0);
    expect(text(root)).not.toContain('적용 중');
  });
  it.each([{ brightness: 1.1 }, { contrast: 0.9 }, { saturation: 0.5 }, { grayscale: true }, { invert: true }])(
    'offers reset when tuned with %j',
    (profile) => {
      const { root, props } = mount(fixture({}, profile));
      expect(text(root)).toContain('적용 중');
      click(button(root, '초기화'));
      expect(props.update).toHaveBeenCalledExactlyOnceWith({
        brightness: 1,
        contrast: 1,
        saturation: 1,
        grayscale: false,
        invert: false,
      });
    },
  );
});

describe('UiNextComicSettings crop', () => {
  it.each([
    ['안 함', 'off'],
    ['페이지마다 자동', 'auto'],
    ['직접 지정', 'manual'],
  ] as const)('updates crop mode %s', (label, crop) => {
    const { root, props } = mount();
    click(button(group(root, '여백 자르기 방식'), label));
    expect(props.update).toHaveBeenCalledExactlyOnceWith({ crop });
  });
  it('detects the current page and every zero-based page in automatic mode', () => {
    const { root, props } = mount(fixture({}, { crop: 'auto' }));
    click(button(root, '이 쪽 감지'));
    click(button(root, '전체 4쪽 감지'));
    expect(props.crop.run).toHaveBeenNthCalledWith(1, [2]);
    expect(props.crop.run).toHaveBeenNthCalledWith(2, [0, 1, 2, 3]);
    expect(props.crop.run).toHaveBeenCalledTimes(2);
  });
  it('offers redetection when the current page already has a crop', () => {
    const { root, props } = mount(
      fixture({}, { crop: 'auto', pageCrops: { '2': { top: 0.01, right: 0, bottom: 0, left: 0 } } }),
    );
    click(button(root, '이 쪽 다시 감지'));
    expect(props.crop.run).toHaveBeenCalledExactlyOnceWith([2]);
  });
  it('shows detection progress and cancellation in place of detection buttons', () => {
    const base = fixture({}, { crop: 'auto' });
    const props: Props = {
      ...base,
      crop: { ...base.crop, status: 'running', progress: { current: 2, total: 4, detected: 1 } },
    };
    const { root } = mount(props);
    expect(text(root.findByProps({ role: 'status' }))).toContain('2/4쪽 확인');
    expect(text(root.findByProps({ role: 'status' }))).toContain('1쪽');
    expect(buttons(root, /감지$/)).toHaveLength(0);
    click(button(root, '취소'));
    expect(props.crop.cancel).toHaveBeenCalledExactlyOnceWith();
    expect(props.crop.run).not.toHaveBeenCalled();
  });
  it.each([
    ['top', '위'],
    ['right', '오른쪽'],
    ['bottom', '아래'],
    ['left', '왼쪽'],
  ] as const)('shows all four manual sliders and saves %s without changing other sides', (side, label) => {
    const manualCrop = { top: 0.01, right: 0.02, bottom: 0.03, left: 0.04 };
    const { root, props } = mount(fixture({}, { crop: 'manual', manualCrop }));
    const labels = ['위', '오른쪽', '아래', '왼쪽'];
    const sliders = root.findAllByType(SettingsSlider).filter((node) => labels.includes(node.props.label));
    expect(sliders.map((node) => node.props.label)).toEqual(labels);
    expect(sliders.map((node) => node.props.value)).toEqual([1, 2, 3, 4]);
    const input = root.findByProps({ 'aria-label': `${label} 직접 입력` });
    act(() => input.props.onChange({ target: { value: '12' } }));
    act(() => input.props.onBlur({ currentTarget: { value: '12' } }));
    expect(props.update).toHaveBeenCalledExactlyOnceWith({ manualCrop: { ...manualCrop, [side]: 0.12 } });
    expect(buttons(root, /감지$/)).toHaveLength(0);
  });
  it('omits detection and manual controls when cropping is off', () => {
    const { root } = mount();
    expect(buttons(root, /감지$/)).toHaveLength(0);
    expect(root.findAllByType(SettingsSlider).map((node) => node.props.label)).toEqual(['밝기', '대비', '채도']);
  });
});
