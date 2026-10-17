import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { SelfHostAuthError } from './self-host-auth-service.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const WINDOW_MS = 5 * 60 * 1000;
const PER_IP_LIMIT = 8;
const TOTAL_LIMIT = 64;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Both comparisons always operate on fixed-size digests, including wrong-length input. */
export function matchesSetupCredential(candidate: string, codeDigest: Buffer, legacyToken?: string): boolean {
  const codeMatches = timingSafeEqual(digest(candidate.toUpperCase().replace(/[\s-]/g, '')), codeDigest);
  const legacyMatches = timingSafeEqual(digest(candidate.trim()), digest(legacyToken ?? ''));
  return codeMatches || (Boolean(legacyToken) && legacyMatches);
}

/** Process-local bootstrap only. No fixed-code environment variable or public retrieval endpoint. */
export class SelfHostSetupCode {
  private codeDigest?: Buffer;
  private consumed = false;
  private attempts = new Map<string, number>();
  private windowStarted = 0;
  private total = 0;

  constructor(
    private readonly announce: (code: string) => void,
    private readonly now = Date.now,
  ) {}

  ensureIssued(): void {
    if (this.consumed) throw new SelfHostAuthError('account_already_registered', 409);
    if (this.codeDigest) return;
    // 12 independent symbols (60 bits), with no 0/O/1/I.
    const code = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    this.codeDigest = digest(code);
    this.announce(code.match(/.{4}/g)!.join('-'));
  }

  verify(candidate: string, ip: string, legacyToken?: string): void {
    this.ensureIssued();
    const now = this.now();
    if (now - this.windowStarted >= WINDOW_MS) {
      this.windowStarted = now;
      this.total = 0;
      this.attempts.clear();
    }
    const key = ip.slice(0, 200);
    const count = this.attempts.get(key) ?? 0;
    if (count >= PER_IP_LIMIT || this.total >= TOTAL_LIMIT) throw new SelfHostAuthError('setup_rate_limited', 429);
    this.total += 1;
    this.attempts.set(key, count + 1);
    if (!matchesSetupCredential(candidate, this.codeDigest!, legacyToken))
      throw new SelfHostAuthError('invalid_setup_code', 403);
  }

  invalidate(): void {
    this.consumed = true;
    this.codeDigest = undefined;
    this.attempts.clear();
  }
}
