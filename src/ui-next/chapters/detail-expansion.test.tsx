import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Synopsis } from './Synopsis';
import { DetailTags } from './DetailTags';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

for (const kind of ['synopsis', 'tags'] as const) {
  describe(kind === 'synopsis' ? 'Synopsis' : 'DetailTags', () => {
    function mount(overflow: boolean) {
      let resize: (() => void) | undefined;
      const dimensions =
        kind === 'synopsis'
          ? { scrollHeight: overflow ? 160 : 40, clientHeight: 40 }
          : { scrollWidth: overflow ? 500 : 200, clientWidth: 200 };
      const disconnect = vi.fn();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe = vi.fn();
          disconnect = disconnect;
        },
      );
      const render = () =>
        kind === 'synopsis' ? <Synopsis text="작품 설명입니다." /> : <DetailTags tags={['판타지', '모험']} />;
      act(() => {
        renderer = create(render(), { createNodeMock: () => dimensions });
      });
      const control = () =>
        renderer!.root.findByProps({ 'aria-label': kind === 'synopsis' ? '작품 설명' : '작품 태그' });
      return { control, dimensions, resize: () => act(() => resize?.()), disconnect };
    }

    it('has no button semantics or toggle handlers when all content fits', () => {
      const { control } = mount(false);
      expect(control().props.role).toBeUndefined();
      expect(control().props.tabIndex).toBeUndefined();
      expect(control().props['aria-expanded']).toBeUndefined();
      expect(control().props.onClick).toBeUndefined();
      expect(control().props.onKeyDown).toBeUndefined();
    });

    it('expands and folds clipped content on click', () => {
      const { control } = mount(true);
      expect(control().props.role).toBe('button');
      expect(control().props.tabIndex).toBe(0);
      expect(control().props['aria-expanded']).toBe(false);
      act(() => control().props.onClick());
      expect(control().props['aria-expanded']).toBe(true);
      act(() => control().props.onClick());
      expect(control().props['aria-expanded']).toBe(false);
    });

    it.each(['Enter', ' '])('toggles clipped content with %s and prevents scrolling', (key) => {
      const { control } = mount(true);
      const preventDefault = vi.fn();
      act(() => control().props.onKeyDown({ key, preventDefault }));
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(control().props['aria-expanded']).toBe(true);
      act(() => control().props.onKeyDown({ key, preventDefault }));
      expect(control().props['aria-expanded']).toBe(false);
      act(() => control().props.onKeyDown({ key: 'Escape', preventDefault }));
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(control().props['aria-expanded']).toBe(false);
    });

    it('responds to resize measurements and releases the observer on unmount', () => {
      const { control, dimensions, resize, disconnect } = mount(false);
      if ('scrollHeight' in dimensions) dimensions.scrollHeight = 160;
      else dimensions.scrollWidth = 500;
      resize();
      expect(control().props.role).toBe('button');
      if ('scrollHeight' in dimensions) dimensions.scrollHeight = 40;
      else dimensions.scrollWidth = 200;
      resize();
      expect(control().props.role).toBeUndefined();
      act(() => renderer!.unmount());
      renderer = undefined;
      expect(disconnect).toHaveBeenCalledOnce();
    });
  });
}
