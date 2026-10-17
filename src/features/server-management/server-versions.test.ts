import { expect, it } from 'vitest';
import { compareVersions, formatDownloadSize } from './server-versions';

it('orders releases and prereleases', () => {
  expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
  expect(compareVersions('v0.1.1', '0.1.1')).toBe(0);
  expect(compareVersions('0.1.1', '0.1.1-beta.3')).toBeGreaterThan(0);
  expect(compareVersions('0.1.1-beta.10', '0.1.1-beta.3')).toBeGreaterThan(0);
  expect(compareVersions('0.1.1-beta.3', '0.1.1-rc.1')).toBeLessThan(0);
  expect(compareVersions('0.1.1-beta', '0.1.1-beta.1')).toBeLessThan(0);
  expect(compareVersions('unknown', '0.1.1')).toBe(0);
});

it('formats download sizes', () => {
  expect(formatDownloadSize(180 * 1024 ** 2)).toBe('180MB');
  expect(formatDownloadSize(1.5 * 1024 ** 3)).toBe('1.5GB');
  expect(formatDownloadSize(10)).toBe('1KB');
});
