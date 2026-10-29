import { expect, it, vi } from 'vitest';
import { ttsHttpError, googleTtsHttpError } from './tts-http-error.js';
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

it('honors Google RetryInfo and the longer header without exposing response content', async () => {
  const body = JSON.stringify({
    error: {
      message: 'private-project-secret',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '63.1s' }],
    },
  });
  const error = await googleTtsHttpError('Limited', new Response(body, { status: 429 }));
  expect(error).toMatchObject({ status: 429, retryAfterSeconds: 64 });
  expect(JSON.stringify(error)).not.toContain('private');
  expect(
    await googleTtsHttpError('Limited', new Response(body, { status: 429, headers: { 'retry-after': '120' } })),
  ).toMatchObject({ retryAfterSeconds: 120 });
  for (const invalid of [
    'invalid',
    'x'.repeat(17000),
    JSON.stringify({ error: { details: [{ retryDelay: 'Infinitys' }] } }),
  ])
    expect(await googleTtsHttpError('Limited', new Response(invalid, { status: 429 }))).toMatchObject({ status: 429 });
});

it('does not wait indefinitely for an error body', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
    const pending = googleTtsHttpError('Limited', new Response(body, { status: 429 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ status: 429 });
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('retains a confirmed zero Vertex creation quota without the project or provider error message', async () => {
  const error = await googleTtsHttpError(
    'Limited',
    Response.json(
      {
        error: {
          message: 'private provider message',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              metadata: {
                consumer: 'projects/private-project',
                quota_metric: 'aiplatform.googleapis.com/voice_creations',
                quota_limit_value: '0',
              },
            },
          ],
        },
      },
      { status: 429 },
    ),
  );
  expect(error).toMatchObject({ status: 429, voiceCreationQuota: 0 });
  expect(JSON.stringify(error)).not.toContain('private');
});
