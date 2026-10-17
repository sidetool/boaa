import { expect, it, vi } from 'vitest';
import { visibleTextOffset } from './visible-text-offset';
it('finds the first visible character without walking every sentence or character', () => {
  const visible = vi.fn((index: number) => index >= 7300);
  expect(visibleTextOffset(10000, visible)).toBe(7300);
  expect(visible.mock.calls.length).toBeLessThan(15);
  expect(visibleTextOffset(0, visible)).toBe(0);
  expect(visibleTextOffset(10000, () => true)).toBe(0);
});
