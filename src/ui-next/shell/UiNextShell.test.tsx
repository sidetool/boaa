import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiNextShell } from './UiNextShell';

class ScrollElement extends EventTarget {
  scrollTop = 0;
  scrollLeft = 0;
}
let renderer: ReactTestRenderer | undefined;
let documentEvents: EventTarget & { scrollingElement: ScrollElement; querySelector: ReturnType<typeof vi.fn> };
beforeEach(() => {
  documentEvents = Object.assign(new EventTarget(), {
    scrollingElement: new ScrollElement(),
    querySelector: vi.fn(() => ({})),
  });
  vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('window', { scrollY: 0 });
  vi.stubGlobal('HTMLElement', ScrollElement);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function mount() {
  act(() => {
    renderer = create(
      <UiNextShell
        activeTab="home"
        isReader={false}
        searchFocusRequest={0}
        openHome={vi.fn()}
        openLibraryRoot={vi.fn()}
        openSettings={vi.fn()}
        focusSearch={vi.fn()}
      >
        <main />
      </UiNextShell>,
    );
  });
  return () => renderer!.root.findByType('header').props.className.includes('is-scrolled');
}
function scroll(target: EventTarget) {
  const event = new Event('scroll');
  Object.defineProperty(event, 'target', { value: target });
  act(() => {
    documentEvents.dispatchEvent(event);
  });
}

describe('UiNextShell vertical scroll tracking', () => {
  it('ignores a horizontal rail scroll while the bar is already below the top', () => {
    const scrolled = mount();
    const content = new ScrollElement();
    const rail = new ScrollElement();
    content.scrollTop = 80;
    scroll(content);
    expect(scrolled()).toBe(true);
    rail.scrollLeft = 330;
    scroll(rail);
    expect(scrolled()).toBe(true);
    rail.scrollLeft = 660;
    scroll(rail);
    expect(scrolled()).toBe(true);
    content.scrollTop = 0;
    scroll(content);
    expect(scrolled()).toBe(false);
  });

  it('ignores scrollLeft-only changes on an already tracked target', () => {
    const scrolled = mount();
    const rail = new ScrollElement();
    const content = new ScrollElement();
    scroll(rail);
    content.scrollTop = 40;
    scroll(content);
    expect(scrolled()).toBe(true);
    rail.scrollLeft = 300;
    scroll(rail);
    expect(scrolled()).toBe(true);
    rail.scrollTop = 4;
    scroll(rail);
    expect(scrolled()).toBe(false);
    rail.scrollLeft = 600;
    scroll(rail);
    expect(scrolled()).toBe(false);
  });

  it.each([
    [12, false],
    [13, true],
    [100, true],
    [0, false],
  ] as const)('reflects document vertical scrollTop=%s as scrolled=%s', (top, expected) => {
    const scrolled = mount();
    documentEvents.scrollingElement.scrollTop = top;
    scroll(documentEvents);
    expect(scrolled()).toBe(expected);
  });

  it('removes its capture listener on unmount', () => {
    const remove = vi.spyOn(documentEvents, 'removeEventListener');
    mount();
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true });
  });
});
