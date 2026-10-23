import { describe, expect, it } from 'vitest';
import { releaseHandoffSpace, reserveHandoffSpace } from './reader-handoff-space';

function scroller() {
  let contentHeight = 3200;
  let top = 2356;
  const space = {
    style: { height: '0px' },
    get offsetHeight() {
      return Number.parseFloat(this.style.height);
    },
  } as HTMLElement;
  const root = {
    clientHeight: 844,
    get scrollHeight() {
      return contentHeight + space.offsetHeight;
    },
    get scrollTop() {
      return Math.min(top, this.scrollHeight - this.clientHeight);
    },
    set scrollTop(value: number) {
      top = Math.min(value, this.scrollHeight - this.clientHeight);
    },
  } as HTMLElement;
  return { root, space, append: () => (contentHeight += 2500) };
}

describe('short page native handoff', () => {
  it('preserves the page anchor instead of clamping it to the document end', () => {
    const { root, space } = scroller();
    reserveHandoffSpace(root, space, 2855);
    root.scrollTop = 2855;
    expect(root.scrollTop).toBe(2855);
    expect(space.offsetHeight).toBe(499);
    reserveHandoffSpace(root, space, 2855);
    expect(space.offsetHeight).toBe(499);
    root.scrollTop -= 45;
    releaseHandoffSpace(root, space);
    expect(root.scrollTop).toBe(2810);
    expect(space.offsetHeight).toBe(499);
  });

  it.each(['scroll', 'append'] as const)('releases space without moving text after %s', (action) => {
    const { root, space, append } = scroller();
    reserveHandoffSpace(root, space, 2855);
    root.scrollTop = 2855;
    if (action === 'scroll') root.scrollTop = 2300;
    else append();
    const before = root.scrollTop;
    releaseHandoffSpace(root, space);
    expect(space.offsetHeight).toBe(0);
    expect(root.scrollTop).toBe(before);
  });

  it('does not add space when the next chapter already supplies the range', () => {
    const { root, space, append } = scroller();
    append();
    reserveHandoffSpace(root, space, 2855);
    expect(space.offsetHeight).toBe(0);
  });
});
