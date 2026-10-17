import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { dispatchAndroidBackEscape } from '../platform/android/app-navigation';
import { useReaderOverflowBack } from './use-reader-overflow-back';
afterEach(() => vi.unstubAllGlobals());
it('acknowledges Android back only while overflow is open and lets Sheet own closing', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  const sheet = vi.fn((event: Event) => event.stopPropagation());
  target.addEventListener('keydown', sheet, true);
  const back = () =>
    dispatchAndroidBackEscape(
      target,
      () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }) as KeyboardEvent,
    );
  function Harness({ open }: { open: boolean }) {
    useReaderOverflowBack(open);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness open={false} />);
  });
  try {
    expect(back()).toBe(false);
    act(() => renderer.update(<Harness open />));
    expect(back()).toBe(true);
    const normal = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    target.dispatchEvent(normal);
    expect(normal.defaultPrevented).toBe(false);
    expect(sheet).toHaveBeenCalledTimes(3);
    act(() => renderer.update(<Harness open={false} />));
    expect(back()).toBe(false);
  } finally {
    act(() => renderer.unmount());
  }
  expect(back()).toBe(false);
});
