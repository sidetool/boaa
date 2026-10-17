import { useState, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../repositories/reader-defaults';
import type { ReaderChromeProps } from '../features/reader/reader-chrome-contract';
import { UiNextReaderChrome } from './reader/UiNextReaderChrome';
import { Sheet, ActionList } from './components/primitives';
vi.mock('./components/primitives', async (original) => ({
  ...(await original<typeof import('./components/primitives')>()),
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
}));
it('uses the reader-owned overflow state for toggle, Sheet dismissal and action completion', () => {
  const openSync = vi.fn();
  const props = {
    model: {
      novel: { id: 'book', title: '책' },
      chapter: { index: 1, title: '회차', paragraphCount: 10 },
      chapters: [{}],
      settings: defaultSettings,
    },
    screenHandle: { getActions: () => ({ openSync }) },
    chrome: {},
    search: { query: '' },
    mode: 'read',
    readingFlow: 'scroll',
  } as unknown as ReaderChromeProps;
  function Harness() {
    const [overflowOpen, onOverflowOpenChanged] = useState(false);
    return <UiNextReaderChrome {...props} overflowOpen={overflowOpen} onOverflowOpenChanged={onOverflowOpenChanged} />;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  try {
    const toggle = () => renderer.root.findByProps({ 'aria-label': '리더 추가 메뉴' });
    act(() => toggle().props.onClick());
    expect(renderer.root.findByType(Sheet).props.open).toBe(true);
    act(() => renderer.root.findByType(Sheet).props.onClose());
    expect(toggle().props['aria-expanded']).toBe(false);
    act(() => toggle().props.onClick());
    const list = renderer.root.findByType(ActionList);
    act(() => {
      list.props.actions.find((entry: { id?: string }) => entry.id === 'sync').run();
      list.props.onDone();
    });
    expect(openSync).toHaveBeenCalledOnce();
    expect(toggle().props['aria-expanded']).toBe(false);
  } finally {
    act(() => renderer.unmount());
  }
});
