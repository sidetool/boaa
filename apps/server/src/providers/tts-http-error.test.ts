import { expect, it } from 'vitest';
import { ttsHttpError } from './tts-http-error.js';
it('preserves status and seconds/date cooldowns without response text', () => {
  const now = Date.UTC(2026, 0, 1);
  for (const header of ['600', new Date(now + 600000).toUTCString()]) {
    const response = new Response('private response', { status: 429, headers: { 'retry-after': header } });
    expect(ttsHttpError('Fixture', response, now)).toMatchObject({ status: 429, retryAfterSeconds: 600 });
    expect(ttsHttpError('Fixture', response, now).message).not.toContain('private');
  }
  for (const header of ['-1', 'invalid', 'Infinity', ''])
    expect(
      ttsHttpError('Fixture', new Response('', { status: 503, headers: { 'retry-after': header } }), now),
    ).not.toHaveProperty('retryAfterSeconds');
});
