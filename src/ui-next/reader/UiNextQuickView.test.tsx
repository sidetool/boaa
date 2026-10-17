import type { ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadingProfile } from '../../domain/types';
import { DEFAULT_READING_PROFILE, READING_PROFILE_LIMITS } from '../../features/reader-settings/reading-profile';
import { UiNextQuickView } from './UiNextQuickView';

type Props = ComponentProps<typeof UiNextQuickView>;
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function fixture(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    profile: {
      ...DEFAULT_READING_PROFILE,
      theme: 'light',
      fontId: 'builtin-serif',
      fontSize: 20,
      lineHeight: 2,
      marginX: 12,
      pageSpread: 'single',
    },
    readingFlow: 'scroll',
    bookOverrideEnabled: false,
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onSetBookOverride: vi.fn(),
    onOpenAllSettings: vi.fn(),
    onRetrySave: vi.fn(),
    ...overrides,
  };
}
function withProfile(patch: Partial<ReadingProfile>): Props {
  const props = fixture();
  return { ...props, profile: { ...props.profile, ...patch } };
}
function mount(props = fixture()) {
  act(() => {
    renderer = create(<UiNextQuickView {...props} />);
  });
  return { root: renderer!.root, props };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
function group(root: ReactTestInstance, label: string) {
  return root.findByProps({ role: 'radiogroup', 'aria-label': label });
}
function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

describe('UiNextQuickView visibility and themes', () => {
  it('renders nothing while closed', () => {
    mount(fixture({ open: false }));
    expect(renderer!.toJSON()).toBeNull();
  });
  it.each([
    ['light', '밝게'],
    ['sepia', '세피아'],
    ['dark', '어둡게'],
    ['midnight', '밤'],
  ] as const)('selects the %s theme through an accessible radio', (theme, label) => {
    const { root, props } = mount(withProfile({ theme }));
    const themes = group(root, '테마');
    expect(themes.findAllByProps({ role: 'radio' })).toHaveLength(4);
    expect(themes.findAllByProps({ 'aria-checked': true })).toHaveLength(1);
    const choice = button(themes, label);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ theme });
  });
});

describe('UiNextQuickView steppers', () => {
  it.each([
    ['글자 크기 줄이기', 19],
    ['글자 크기 키우기', 21],
  ] as const)('changes font size one unit with %s', (label, fontSize) => {
    const { root, props } = mount();
    click(button(root, label));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ fontSize });
  });
  it.each([
    [READING_PROFILE_LIMITS.fontSize.min + 0.25, '글자 크기 줄이기', READING_PROFILE_LIMITS.fontSize.min],
    [READING_PROFILE_LIMITS.fontSize.max - 0.25, '글자 크기 키우기', READING_PROFILE_LIMITS.fontSize.max],
  ] as const)('clamps font size %s to the boundary with %s', (value, label, fontSize) => {
    const { root, props } = mount(withProfile({ fontSize: value }));
    click(button(root, label));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ fontSize });
  });
  it.each([
    [READING_PROFILE_LIMITS.fontSize.min, '글자 크기 줄이기'],
    [READING_PROFILE_LIMITS.fontSize.max, '글자 크기 키우기'],
  ] as const)('disables font size %s at its boundary', (fontSize, label) => {
    const { root, props } = mount(withProfile({ fontSize }));
    expect(button(root, label).props.disabled).toBe(true);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });
  it.each([
    ['줄 간격 줄이기', 1.95],
    ['줄 간격 키우기', 2.05],
  ] as const)('changes line height by 0.05 with %s', (label, lineHeight) => {
    const { root, props } = mount();
    click(button(root, label));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ lineHeight: expect.closeTo(lineHeight, 10) });
  });
  it.each([
    [READING_PROFILE_LIMITS.lineHeight.min + 0.01, '줄 간격 줄이기', READING_PROFILE_LIMITS.lineHeight.min],
    [READING_PROFILE_LIMITS.lineHeight.max - 0.01, '줄 간격 키우기', READING_PROFILE_LIMITS.lineHeight.max],
  ] as const)('clamps line height %s to the boundary with %s', (value, label, lineHeight) => {
    const { root, props } = mount(withProfile({ lineHeight: value }));
    click(button(root, label));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ lineHeight: expect.closeTo(lineHeight, 10) });
  });
  it.each([
    [READING_PROFILE_LIMITS.lineHeight.min, '줄 간격 줄이기'],
    [READING_PROFILE_LIMITS.lineHeight.max, '줄 간격 키우기'],
  ] as const)('disables line height %s at its boundary', (lineHeight, label) => {
    const { root, props } = mount(withProfile({ lineHeight }));
    expect(button(root, label).props.disabled).toBe(true);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });
});

describe('UiNextQuickView font, layout and scope', () => {
  it.each([
    ['명조', 'builtin-serif'],
    ['고딕', 'builtin-sans'],
  ] as const)('selects %s with its built-in font id', (label, fontId) => {
    const { root, props } = mount(withProfile({ fontId }));
    const fonts = group(root, '글꼴');
    expect(fonts.findAllByProps({ role: 'radio' }).map(text)).toEqual(['명조', '고딕']);
    expect(button(fonts, label).props['aria-checked']).toBe(true);
    click(button(fonts, label));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ fontId });
  });
  it('preserves an uploaded font through the selected custom-font option', () => {
    const { root, props } = mount(withProfile({ fontId: 'user:my-font' }));
    const fonts = group(root, '글꼴');
    expect(fonts.findAllByProps({ role: 'radio' }).map(text)).toEqual(['명조', '고딕', '내 글꼴']);
    const custom = button(fonts, '내 글꼴');
    expect(custom.props['aria-checked']).toBe(true);
    click(custom);
    expect(props.onUpdate).not.toHaveBeenCalled();
    click(button(fonts, '명조'));
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ fontId: 'builtin-serif' });
  });
  it.each([
    ['좁게', 4],
    ['보통', 12],
    ['넓게', 20],
  ] as const)('sends a numeric horizontal margin for %s', (label, marginX) => {
    const { root, props } = mount(withProfile({ marginX }));
    const margin = button(group(root, '좌우 여백'), label);
    expect(margin.props['aria-checked']).toBe(true);
    click(margin);
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ marginX });
  });
  it.each([
    ['스크롤', 'scroll'],
    ['페이지', 'paginated'],
  ] as const)('changes %s with modeLock and flow together', (label, flow) => {
    const { root, props } = mount(fixture({ readingFlow: flow }));
    const choice = button(group(root, '읽기 방식'), label);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ modeLock: flow, flow });
  });
  it.each(['scroll', 'paginated'] as const)('only offers page spread in paginated flow (%s)', (readingFlow) => {
    const { root } = mount(fixture({ readingFlow }));
    expect(root.findAllByProps({ role: 'radiogroup', 'aria-label': '페이지 펼침' })).toHaveLength(
      readingFlow === 'paginated' ? 1 : 0,
    );
  });
  it.each([
    ['한 쪽', 'single'],
    ['두 쪽', 'double'],
    ['자동', 'auto'],
  ] as const)('sets the %s page spread', (label, pageSpread) => {
    const props = withProfile({ pageSpread });
    const { root } = mount({ ...props, readingFlow: 'paginated' });
    const choice = button(group(root, '페이지 펼침'), label);
    expect(choice.props['aria-checked']).toBe(true);
    click(choice);
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({ pageSpread });
  });
  it.each([false, true])('toggles the book-only override from %s', (bookOverrideEnabled) => {
    const { root, props } = mount(fixture({ bookOverrideEnabled }));
    const toggle = root.findByProps({ role: 'switch', 'aria-label': '이 작품에만 적용' });
    expect(toggle.props['aria-checked']).toBe(bookOverrideEnabled);
    click(toggle);
    expect(props.onSetBookOverride).toHaveBeenCalledExactlyOnceWith(!bookOverrideEnabled);
  });
});

describe('UiNextQuickView navigation and saving', () => {
  it('closes before opening all settings', () => {
    const { root, props } = mount();
    click(button(root, '전체 설정'));
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith();
    expect(props.onOpenAllSettings).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(props.onOpenAllSettings).mock.invocationCallOrder[0],
    );
  });
  it('closes with the dedicated close button', () => {
    const { root, props } = mount();
    click(button(root, '보기 설정 닫기'));
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith();
    expect(props.onOpenAllSettings).not.toHaveBeenCalled();
  });
  it('retries saving from the error alert', () => {
    const { root, props } = mount(fixture({ saveState: { saving: false, dirty: true, error: true } }));
    click(button(root.findByProps({ role: 'alert' }), '저장 실패 · 다시 시도'));
    expect(props.onRetrySave).toHaveBeenCalledExactlyOnceWith();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });
  it.each([
    { saving: true, dirty: false, error: false },
    { saving: false, dirty: true, error: false },
  ])('shows pending save status for %j', (saveState) => {
    const { root } = mount(fixture({ saveState }));
    expect(text(root.findByProps({ role: 'status' }))).toBe('저장 중…');
    expect(root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  });
});
