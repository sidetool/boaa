import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_READER_ADDON_TABS, type ReaderAddonShellProps } from '../../features/reader/reader-addon-contract';
import { UiNextReaderTools } from './UiNextReaderTools';

let renderer: ReactTestRenderer | undefined;
let narrow = false;
beforeEach(() => {
  narrow = false;
  vi.stubGlobal('window', {
    matchMedia: vi.fn(() => ({ matches: narrow, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function fixture(overrides: Partial<ReaderAddonShellProps> = {}): ReaderAddonShellProps {
  return {
    activeTab: 'outline',
    tabs: CORE_READER_ADDON_TABS,
    children: <p>도구 내용</p>,
    setActiveTab: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}
function mount(props = fixture()) {
  act(() => {
    renderer = create(<UiNextReaderTools {...props} />);
  });
  return { root: renderer!.root, props };
}
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('UiNextReaderTools', () => {
  it.each(CORE_READER_ADDON_TABS)('marks $label active and routes tab changes', (current) => {
    const { root, props } = mount(fixture({ activeTab: current.id }));
    const tabs = root.findByProps({ role: 'tablist', 'aria-label': '읽기 도구 분류' }).findAllByProps({ role: 'tab' });
    expect(tabs.map(text)).toEqual(CORE_READER_ADDON_TABS.map((tab) => tab.label));
    expect(tabs.filter((tab) => tab.props['aria-selected'])).toHaveLength(1);
    tabs.forEach((tab, index) => {
      expect(tab.props['aria-selected']).toBe(CORE_READER_ADDON_TABS[index].id === current.id);
      act(() => tab.props.onClick());
      expect(props.setActiveTab).toHaveBeenNthCalledWith(index + 1, CORE_READER_ADDON_TABS[index].id);
    });
    const title = root.findByType('h2');
    expect(text(title)).toBe(current.label);
    const panel = root.findByProps({ role: 'tabpanel' });
    expect(panel.props['aria-labelledby']).toBe(title.props.id);
    expect(text(panel)).toBe('도구 내용');
  });
  it('exposes the plugin close marker and invokes close', () => {
    const { root, props } = mount();
    const close = root.findByProps({ 'aria-label': '읽기 도구 닫기' });
    expect(close.type).toBe('button');
    expect(close.props['data-reader-addon-close']).toBe(true);
    act(() => close.props.onClick());
    expect(props.close).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([false, true])('uses a modal sheet only on narrow screens (%s)', (mobile) => {
    narrow = mobile;
    const { root } = mount();
    expect(root.findByProps({ role: 'dialog' }).props['aria-modal']).toBe(mobile || undefined);
    expect(root.findByType('aside').props['aria-labelledby']).toBe(root.findByType('h2').props.id);
  });
});
