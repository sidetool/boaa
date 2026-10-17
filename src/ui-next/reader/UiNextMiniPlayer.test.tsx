import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSCompactBarProps } from '../../features/tts/tts-compact-contract';
import UiNextMiniPlayer from './UiNextMiniPlayer';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function fixture(overrides: Partial<TTSCompactBarProps> = {}): TTSCompactBarProps {
  return {
    bookTitle: '테스트 소설',
    chapterTitle: '2화',
    playing: false,
    paused: false,
    busy: false,
    rate: 1.2,
    previous: vi.fn(),
    next: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    openSettings: vi.fn(),
    setTimer: vi.fn(),
    ...overrides,
  };
}
function mount(props = fixture()) {
  act(() => {
    renderer = create(<UiNextMiniPlayer {...props} />);
  });
  return { root: renderer!.root, props };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'button' && node.props['aria-label'] === label);
}
function click(node: ReactTestInstance) {
  act(() => node.props.onClick());
}

describe('UiNextMiniPlayer playback', () => {
  it.each([
    [false, false, 'TTS 재생', 'start'],
    [true, false, 'TTS 일시정지', 'pause'],
    [true, true, 'TTS 계속 재생', 'resume'],
  ] as const)('routes playing=%s paused=%s to %s', (playing, paused, label, action) => {
    const { root, props } = mount(fixture({ playing, paused }));
    click(button(root, label));
    for (const key of ['start', 'pause', 'resume'] as const)
      expect(props[key]).toHaveBeenCalledTimes(key === action ? 1 : 0);
    expect(root.findByType('section').props['data-playing']).toBe(playing);
    expect(root.findByType('section').props.className.split(' ').includes('is-playing')).toBe(playing && !paused);
  });
  it.each([
    ['이전 문단', 'previous'],
    ['다음 문단', 'next'],
    ['TTS 정지', 'stop'],
    ['듣기 설정 열기', 'openSettings'],
  ] as const)('routes %s to %s', (label, action) => {
    const { root, props } = mount();
    click(button(root, label));
    expect(props[action]).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([1, 1.2, 1.8])('displays the chapter and speed %s', (rate) => {
    const { root } = mount(fixture({ rate }));
    const info = button(root, '듣기 설정 열기');
    expect(text(info.findByType('b'))).toBe('2화');
    expect(info.findAllByType('em').map(text)).toContain(`${rate.toFixed(1)}x`);
    expect(text(info)).toContain('테스트 소설');
  });
});

describe('UiNextMiniPlayer sleep timer', () => {
  it('cycles through all presets and back to off with updated controlled props', () => {
    const { root, props } = mount();
    const cycle = [undefined, 10, 20, 30, 60, 'end_of_chapter', undefined] as const;
    for (let index = 0; index < cycle.length - 1; index++) {
      const current = cycle[index];
      act(() => renderer!.update(<UiNextMiniPlayer {...props} timerPreset={current} />));
      const label = current === undefined ? '끔' : current === 'end_of_chapter' ? '화 끝' : `${current}분`;
      const timer = button(root, `수면 타이머 ${label}, 눌러서 바꾸기`);
      expect(timer.props.className.split(' ').includes('is-on')).toBe(current !== undefined);
      click(timer);
      expect(props.setTimer).toHaveBeenNthCalledWith(index + 1, cycle[index + 1]);
    }
    expect(props.setTimer).toHaveBeenCalledTimes(6);
  });
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [60, '1:00'],
    [65, '1:05'],
    [3599, '59:59'],
  ] as const)('formats %s remaining seconds as %s', (timerRemainingSeconds, display) => {
    const { root } = mount(fixture({ timerPreset: 10, timerRemainingSeconds }));
    expect(button(root, '듣기 설정 열기').findAllByType('em').map(text)).toEqual(['1.2x', display]);
  });
  it('shows the end-of-chapter timer without a numeric countdown', () => {
    const { root } = mount(fixture({ timerPreset: 'end_of_chapter' }));
    expect(button(root, '듣기 설정 열기').findAllByType('em').map(text)).toEqual(['1.2x', '화 끝']);
  });
  it('omits a countdown when no timer is active', () => {
    const { root } = mount();
    expect(button(root, '듣기 설정 열기').findAllByType('em').map(text)).toEqual(['1.2x']);
  });
});
