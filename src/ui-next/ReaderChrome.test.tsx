import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReaderChromeProps } from '../features/reader/reader-chrome-contract';
import { ReaderChrome } from './ReaderChrome';
const mocks = vi.hoisted(() => ({ next: vi.fn(() => null) }));
vi.mock('./reader/UiNextReaderChrome', () => ({ UiNextReaderChrome: mocks.next }));
afterEach(() => vi.clearAllMocks());
it('selects once per mount and forwards overflow state', () => {
  let renderer!: ReactTestRenderer;
  const props = { overflowOpen: false, onOverflowOpenChanged: vi.fn() } as unknown as ReaderChromeProps;
  act(() => {
    renderer = create(<ReaderChrome {...props} />);
  });
  try {
    for (let index = 0; index < 5; index++) act(() => renderer.update(<ReaderChrome {...props} overflowOpen />));

    const component = mocks.next;
    const received = component.mock.calls.at(-1) as unknown as [ReaderChromeProps];
    expect(received[0].overflowOpen).toBe(true);
    received[0].onOverflowOpenChanged(false);
    expect(props.onOverflowOpenChanged).toHaveBeenCalledWith(false);
  } finally {
    act(() => renderer.unmount());
  }
});
