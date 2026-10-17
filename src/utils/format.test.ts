import { expect, it } from 'vitest';
import { formatCount, formatDateTime } from './format';

it('retains Korean number and date formatting when formatter instances are reused', () => {
  for (const value of [0, -0, 1234567, -42.5, Number.NaN, Infinity])
    expect(formatCount(value)).toBe(new Intl.NumberFormat('ko-KR').format(value));
  for (const value of ['2026-01-01T01:23:00Z', '2026-10-16T23:59:00Z'])
    expect(formatDateTime(value)).toBe(
      new Intl.DateTimeFormat('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value)),
    );
  expect(formatDateTime()).toBe('-');
  expect(() => formatDateTime('invalid')).toThrow(RangeError);
});
