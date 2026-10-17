import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiNextChapterTransition, type UiNextChapterTransitionProps } from './UiNextChapterTransition';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function mount(overrides: Partial<UiNextChapterTransitionProps> = {}) {
  const props: UiNextChapterTransitionProps = { title: '10화', phase: 'opening', ...overrides };
  act(() => {
    renderer = create(<UiNextChapterTransition {...props} />);
  });
  return renderer!.root;
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('UiNextChapterTransition', () => {
  it.each(['importing', 'opening'] as const)(
    'announces %s and only explains library import during importing',
    (phase) => {
      const root = mount({ phase });
      const status = root.findByProps({ role: 'status' });
      expect(text(status)).toContain('10화 여는 중');
      expect(text(status).includes('서재에 저장하고 있어요')).toBe(phase === 'importing');
      expect(root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(root.findAllByProps({ className: 'un-chapter-transition-bar' })).toHaveLength(1);
    },
  );
  it.each([false, true])('shows the failed title and optional retry (%s)', (canRetry) => {
    const onRetry = canRetry ? vi.fn() : undefined;
    const root = mount({ phase: 'importing', error: '연결 끊김', onRetry });
    const alert = root.findByProps({ role: 'alert' });
    expect(text(alert)).toContain('10화 · 열지 못했어요');
    expect(text(alert)).not.toContain('서재에 저장하고 있어요');
    expect(root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(root.findAllByProps({ className: 'un-chapter-transition-bar' })).toHaveLength(0);
    const retries = alert.findAllByType('button');
    expect(retries).toHaveLength(canRetry ? 1 : 0);
    if (onRetry) {
      expect(text(retries[0])).toBe('다시 시도');
      act(() => retries[0].props.onClick());
      expect(onRetry).toHaveBeenCalledExactlyOnceWith();
    }
  });
});
