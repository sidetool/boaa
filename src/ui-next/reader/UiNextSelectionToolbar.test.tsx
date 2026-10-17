import type { ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderScreenHandle } from '../../features/reader/reader-screen-contract';
import { UiNextSelectionToolbar } from './UiNextSelectionToolbar';

type Props = ComponentProps<typeof UiNextSelectionToolbar>;
let renderer: ReactTestRenderer | undefined;
let writeText: ReturnType<typeof vi.fn>;
let execCommand: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  execCommand = vi.fn(() => false);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('document', { execCommand });
  vi.stubGlobal('window', { setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay) });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(overrides: Partial<Props> = {}) {
  const screenHandle = new ReaderScreenHandle();
  const actions = {
    ...screenHandle.getActions(),
    highlightSelection: vi.fn().mockResolvedValue(undefined),
    openSelectionNote: vi.fn(),
    previewSelectionTTS: vi.fn(),
  };
  screenHandle.setActions(actions);
  const props: Props = {
    selection: { text: '선택한 문장', paragraphId: 'paragraph-1' },
    location: { progress: 0.4, scrollTop: 100, paragraphIndex: 2, ttsIndex: 2 },
    screenHandle,
    onClear: vi.fn(),
    ...overrides,
  };
  return { props, actions };
}
function mount(value = fixture()) {
  act(() => {
    renderer = create(<UiNextSelectionToolbar {...value.props} />);
  });
  return { root: renderer!.root, ...value };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}

describe('UiNextSelectionToolbar actions', () => {
  it.each([
    ['노랑 하이라이트', 'yellow'],
    ['초록 하이라이트', 'green'],
    ['파랑 하이라이트', 'blue'],
    ['분홍 하이라이트', 'pink'],
    ['선택 범위의 하이라이트 삭제', 'remove'],
  ] as const)('sends %s with the exact location and selection', async (label, color) => {
    const { root, props, actions } = mount();
    await click(button(root, label));
    expect(actions.highlightSelection).toHaveBeenCalledExactlyOnceWith(props.location, props.selection, color);
    expect(props.onClear).not.toHaveBeenCalled();
  });
  it('disables all highlight actions without a location', () => {
    const { root, actions } = mount(fixture({ location: undefined }));
    const palette = root.findByProps({ role: 'group', 'aria-label': '선택 문장 하이라이트' });
    expect(palette.findAllByType('button')).toHaveLength(5);
    expect(palette.findAllByType('button').every((node) => node.props.disabled)).toBe(true);
    expect(actions.highlightSelection).not.toHaveBeenCalled();
  });
  it('blocks repeat highlighting until the pending action settles', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const value = fixture();
    value.actions.highlightSelection.mockReturnValue(pending);
    const { root, actions } = mount(value);
    act(() => button(root, '노랑 하이라이트').props.onClick());
    const palette = root.findByProps({ role: 'group', 'aria-label': '선택 문장 하이라이트' });
    expect(palette.findAllByType('button').every((node) => node.props.disabled)).toBe(true);
    // Also guard a programmatic second request while the async action is pending.
    act(() => button(root, '분홍 하이라이트').props.onClick());
    expect(actions.highlightSelection).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await pending;
    });
    expect(palette.findAllByType('button').every((node) => !node.props.disabled)).toBe(true);
  });
  it('opens a note for the selected text', async () => {
    const { root, props, actions } = mount();
    await click(button(root, '메모'));
    expect(actions.openSelectionNote).toHaveBeenCalledExactlyOnceWith(props.selection);
    expect(props.onClear).not.toHaveBeenCalled();
  });
  it('previews speech before clearing the selection', async () => {
    const { root, props, actions } = mount();
    await click(button(root, '선택 문장 듣기'));
    expect(actions.previewSelectionTTS).toHaveBeenCalledExactlyOnceWith(props.selection);
    expect(props.onClear).toHaveBeenCalledExactlyOnceWith();
    expect(actions.previewSelectionTTS.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(props.onClear).mock.invocationCallOrder[0],
    );
  });
  it('clears the selection with the close action', async () => {
    const { root, props } = mount();
    await click(button(root, '선택 해제'));
    expect(props.onClear).toHaveBeenCalledExactlyOnceWith();
  });
  it('exposes the selected character count in the toolbar accessible name', () => {
    const { root } = mount(fixture({ selection: { text: '가'.repeat(1234), paragraphId: 'paragraph-1' } }));
    expect(root.findByProps({ role: 'toolbar' }).props['aria-label']).toBe('1,234자 선택');
  });
  it.each(['onPointerDown', 'onMouseDown'])('preserves selection on %s', (event) => {
    const { root } = mount();
    const preventDefault = vi.fn();
    act(() => root.findByProps({ role: 'toolbar' }).props[event]({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('UiNextSelectionToolbar copy', () => {
  it('copies the selected text, shows feedback, then clears after 600ms', async () => {
    const { root, props } = mount();
    await click(button(root, '선택 문장 복사'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(props.selection.text);
    expect(execCommand).not.toHaveBeenCalled();
    expect(text(button(root, '선택 문장 복사'))).toBe('복사됨');
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(props.onClear).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(props.onClear).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([true, false])('falls back to execCommand when clipboard rejects (copied=%s)', async (copied) => {
    writeText.mockRejectedValue(new Error('clipboard denied'));
    execCommand.mockReturnValue(copied);
    const { root, props } = mount();
    await click(button(root, '선택 문장 복사'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(props.selection.text);
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(text(button(root, '선택 문장 복사'))).toBe(copied ? '복사됨' : '복사');
    expect(props.onClear).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(props.onClear).toHaveBeenCalledTimes(copied ? 1 : 0);
  });
  it('uses the fallback when the Clipboard API is absent', async () => {
    vi.stubGlobal('navigator', {});
    execCommand.mockReturnValue(true);
    const { root, props } = mount();
    await click(button(root, '선택 문장 복사'));
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(text(button(root, '선택 문장 복사'))).toBe('복사됨');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(props.onClear).toHaveBeenCalledExactlyOnceWith();
  });
});
