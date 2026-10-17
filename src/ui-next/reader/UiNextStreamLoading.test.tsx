import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiNextStreamLoading, type UiNextStreamLoadingProps } from './UiNextStreamLoading';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function mount(overrides: Partial<UiNextStreamLoadingProps> = {}) {
  const props: UiNextStreamLoadingProps = {
    workTitle: '테스트 작품',
    episodeTitle: '6화',
    onClose: vi.fn(),
    ...overrides,
  };
  act(() => {
    renderer = create(<UiNextStreamLoading {...props} />);
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

describe('UiNextStreamLoading', () => {
  it.each(['pages', 'text'] as const)('keeps the header and %s stage while opening an episode', (variant) => {
    const { root } = mount({ variant });
    const main = root.findByType('main');
    expect(main.props['aria-busy']).toBe(true);
    expect(main.props.className.split(' ')).toContain(variant === 'pages' ? 'is-comic' : 'is-text');
    const header = root.findByType('header');
    expect(text(header.findByType('strong'))).toBe('테스트 작품');
    expect(text(header.findByType('small'))).toBe('6화');
    expect(text(root.findByProps({ role: 'status' }))).toBe('6화 여는 중');
    const stage = root.findByProps({ className: 'un-stream-wait-stage' });
    expect(String(stage.props['aria-hidden'])).toBe('true');
    if (variant === 'text') {
      expect(stage.findAllByType('p')).toHaveLength(4);
      expect(stage.findAllByType('p').every((paragraph) => paragraph.findAllByType('span').length === 3)).toBe(true);
    } else {
      expect(stage.findAllByType('p')).toHaveLength(0);
      expect(stage.findAllByType('span')).toHaveLength(2);
    }
  });
  it('uses the pages stage by default and closes from the header', () => {
    const { root, props } = mount();
    expect(root.findByType('main').props.className.split(' ')).toContain('is-comic');
    act(() => button(root, '회차 목록으로').props.onClick());
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith();
  });
  it('shows one title line when work and episode titles are equal', () => {
    const { root } = mount({ workTitle: '같은 제목', episodeTitle: '같은 제목' });
    const header = root.findByType('header');
    expect(text(header.findByType('strong'))).toBe('같은 제목');
    expect(header.findAllByType('small')).toHaveLength(0);
  });
  it.each([false, true])('shows the error and only offers retry when available (%s)', (canRetry) => {
    const onRetry = canRetry ? vi.fn() : undefined;
    const { root, props } = mount({ error: '소스 연결 실패', onRetry });
    expect(root.findByType('main').props['aria-busy']).toBe(false);
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('회차를 열지 못했어요');
    expect(text(alert)).toContain('소스 연결 실패');
    expect(root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(root.findAllByProps({ className: 'un-stream-wait-stage' })).toHaveLength(0);
    expect(alert.findAllByType('button').filter((node) => text(node).trim() === '다시 시도')).toHaveLength(
      canRetry ? 1 : 0,
    );
    if (onRetry) {
      act(() => button(alert, '다시 시도').props.onClick());
      expect(onRetry).toHaveBeenCalledExactlyOnceWith();
    }
    act(() => button(alert, '목록으로').props.onClick());
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith();
  });
});
