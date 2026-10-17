import { createHash, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createStructuredLogger } from '../observability/logger.js';
import { matchesSetupCredential, SelfHostSetupCode } from './self-host-setup-code.js';
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

describe('owner setup code', () => {
  it('issues one readable process-local code and never reissues a consumed code', () => {
    const codes: string[] = [];
    const setup = new SelfHostSetupCode((code) => codes.push(code));
    setup.ensureIssued();
    setup.ensureIssued();
    expect(codes.length).toBe(1);
    expect(/^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){2}$/.test(codes[0])).toBe(true);
    setup.verify(codes[0].toLowerCase().replaceAll('-', ' '), 'ip');
    setup.invalidate();
    expect(() => setup.verify(codes[0], 'ip')).toThrow('account_already_registered');
    expect(() => setup.ensureIssued()).toThrow('account_already_registered');
    new SelfHostSetupCode((code) => codes.push(code)).ensureIssued();
    expect(codes[0] !== codes[1]).toBe(true);
  });
  it('limits eight attempts per IP and 64 total per five minutes, including legacy-token attempts', () => {
    let now = 1;
    let code = '';
    const setup = new SelfHostSetupCode(
      (value) => {
        code = value;
      },
      () => now,
    );
    for (let i = 0; i < 8; i++)
      expect(() => setup.verify('wrong', 'ip', 'synthetic-legacy')).toThrow('invalid_setup_code');
    expect(() => setup.verify('synthetic-legacy', 'ip', 'synthetic-legacy')).toThrow('setup_rate_limited');
    for (let i = 8; i < 64; i++) expect(() => setup.verify('wrong', `ip-${i}`)).toThrow('invalid_setup_code');
    expect(() => setup.verify(code, 'new-ip')).toThrow('setup_rate_limited');
    now += 300_000;
    expect(() => setup.verify(code, 'ip')).not.toThrow();
  });
  it('uses two constant-size timing-safe comparisons even for wrong-length and Unicode input', () => {
    const hash = createHash('sha256').update('ABCD2345EFGH').digest();
    for (const candidate of ['', 'x', '한글'.repeat(100), 'ABCD-2345-EFGH', 'synthetic-legacy']) {
      vi.mocked(timingSafeEqual).mockClear();
      const valid = matchesSetupCredential(candidate, hash, 'synthetic-legacy');
      expect(valid).toBe(candidate === 'ABCD-2345-EFGH' || candidate === 'synthetic-legacy');
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
      expect(vi.mocked(timingSafeEqual).mock.calls.every(([a, b]) => a.byteLength === 32 && b.byteLength === 32)).toBe(
        true,
      );
    }
    expect(matchesSetupCredential('', hash)).toBe(false);
  });
});

it('exposes only the intentional bootstrap event through production log redaction', () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    service: 'api',
    sink: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  const code = 'ABCD-2345-EFGH';
  logger.warn('owner_setup_code', { setupCode: code, password: 'synthetic-password', body: { setupCode: code } });
  logger.warn('other_event', { setupCode: code });
  logger.warn('owner_setup_code', { setupCode: 'invalid-secret-format' });
  expect(JSON.parse(lines[0]).setupCode === code).toBe(true);
  expect(lines.every((line) => !line.includes('synthetic-password') && !line.includes('invalid-secret-format'))).toBe(
    true,
  );
  expect(lines[1].includes(code)).toBe(false);
  expect(JSON.parse(lines[0]).body).not.toEqual({ setupCode: code });
});
