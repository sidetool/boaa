import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  detectTranslationLanguage,
  translationSourceLanguage,
  validateTranslationSettings,
} from '../../../../src/translation/contracts.js';
import {
  TranslationError,
  retryAfterMilliseconds,
  splitTranslationInput,
  validateTranslationOutput,
  withTranslationRetry,
} from './engine.js';

describe('translation boundaries', () => {
  it('defaults to disabled/manual and rejects unsafe settings', () => {
    expect(DEFAULT_TRANSLATION_SETTINGS).toMatchObject({
      enabled: false,
      automatic: false,
      concurrency: 1,
      targetLanguage: 'ko',
    });
    expect(() =>
      validateTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, endpoint: 'http://example.test' }),
    ).toThrow();
    expect(() => validateTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, concurrency: 99 })).toThrow();
    expect(() => validateTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, enabled: true })).toThrow(
      'translation_model_required',
    );
  });
  it('does not guess Latin language or short text and identifies Korean/Japanese', () => {
    expect(detectTranslationLanguage('Hello world')).toBeUndefined();
    expect(translationSourceLanguage('und', 'Unknown language.')).toBeUndefined();
    expect(detectTranslationLanguage('This is a long English sentence. '.repeat(20))).toBeUndefined();
    expect(detectTranslationLanguage('이 작품의 이야기를 한국어로 읽고 있습니다. '.repeat(10))).toBe('ko');
    expect(detectTranslationLanguage('これは日本語の小説です。 '.repeat(20))).toBe('ja');
  });
  it('skips blank paragraphs, keeps order and reconstructs oversized Unicode paragraphs exactly', () => {
    const spaced = splitTranslationInput([{ id: 'space', text: 'a'.repeat(2000) + ' ' + 'b'.repeat(2000) }], 2000);
    expect(spaced.flat().every((part) => part.text.length <= 2000)).toBe(true);
    const source = 'あいうえお😀'.repeat(2000);
    const chunks = splitTranslationInput(
      [
        { id: 'empty', text: '\n\u2003 ' },
        { id: 'long', text: source },
        { id: 'tail', text: '끝' },
      ],
      2000,
    );
    expect(chunks.every((chunk) => chunk.reduce((sum, p) => sum + p.text.length, 0) <= 2000)).toBe(true);
    expect(
      chunks
        .flat()
        .filter((p) => p.paragraphId === 'long')
        .map((p) => p.text)
        .join(''),
    ).toBe(source);
    expect(chunks.flat().some((p) => p.paragraphId === 'empty')).toBe(false);
    expect(new Set(chunks.flat().map((p) => p.id)).size).toBe(chunks.flat().length);
  });
  it('rejects omissions, reordering, blank output and mismatched paragraph IDs', () => {
    const input = splitTranslationInput(
      [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
      ],
      2000,
    )[0];
    const output = input.map((p) => ({ id: p.id, text: '번역' }));
    expect(validateTranslationOutput({ paragraphs: output }, input)).toEqual(output);
    for (const paragraphs of [
      output.slice(1),
      [...output].reverse(),
      [{ id: 'fake', text: '번역' }, output[1]],
      [{ ...output[0], text: '' }, output[1]],
    ])
      expect(() => validateTranslationOutput({ paragraphs }, input)).toThrow('translation_invalid_output');
  });
  it('honors Retry-After and retry count without stacking another retry loop', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new TranslationError('translation_rate_limit', true, 90000))
      .mockResolvedValue('done');
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await withTranslationRetry(DEFAULT_TRANSLATION_SETTINGS, new AbortController().signal, run, sleep)).toBe(
      'done',
    );
    expect(sleep).toHaveBeenCalledWith(90000);
    expect(run).toHaveBeenCalledTimes(2);
    const auth = vi.fn().mockRejectedValue(new TranslationError('translation_auth'));
    await expect(
      withTranslationRetry(DEFAULT_TRANSLATION_SETTINGS, new AbortController().signal, auth, sleep),
    ).rejects.toThrow('translation_auth');
    expect(auth).toHaveBeenCalledTimes(1);
    expect(retryAfterMilliseconds('120')).toBe(120000);
    expect(retryAfterMilliseconds('bad')).toBe(0);
  });
  it('does not retry past automatic wait budget or after cancellation', async () => {
    const sleep = vi.fn();
    await expect(
      withTranslationRetry(
        DEFAULT_TRANSLATION_SETTINGS,
        new AbortController().signal,
        () => Promise.reject(new TranslationError('translation_rate_limit', true, 700000)),
        sleep,
      ),
    ).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    const run = vi.fn();
    await expect(withTranslationRetry(DEFAULT_TRANSLATION_SETTINGS, abort.signal, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Gemini translation wire format', () => {
  it('sends bounded text with a JSON schema and a header key, and rejects truncated output', async () => {
    const { translateChunk } = await import('./engine.js');
    const input = splitTranslationInput([{ id: 'p1', text: 'Synthetic source text.' }], 2000)[0];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [{ text: JSON.stringify({ paragraphs: [{ id: input[0].id, text: '합성 번역' }] }) }],
                },
              },
            ],
          }),
        ),
    );
    try {
      const settings = { ...DEFAULT_TRANSLATION_SETTINGS, model: 'synthetic-model' };
      expect(await translateChunk(settings, 'fake-key', input, new AbortController().signal)).toEqual([
        { id: input[0].id, text: '합성 번역' },
      ]);
      expect(fetch.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/synthetic-model:generateContent',
      );
      expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ 'x-goog-api-key': 'fake-key' });
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
        generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } },
      });
      await translateChunk(settings, 'fake-key', input, new AbortController().signal, 'titles');
      const titleRequest = JSON.parse(String(fetch.mock.calls[1][1]?.body));
      expect(titleRequest.systemInstruction.parts[0].text).toContain('independent work title');
      expect(titleRequest.systemInstruction.parts[0].text).toContain('already in the target language');
      expect(JSON.parse(titleRequest.contents[0].parts[0].text)).toEqual(input.map(({ id, text }) => ({ id, text })));
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }),
        ),
      );
      await expect(translateChunk(settings, 'fake-key', input, new AbortController().signal)).rejects.toThrow(
        'translation_invalid_output',
      );
      fetch.mockResolvedValueOnce(
        new Response('private provider error', { status: 429, headers: { 'Retry-After': '85' } }),
      );
      await expect(translateChunk(settings, 'fake-key', input, new AbortController().signal)).rejects.toMatchObject({
        code: 'translation_rate_limit',
        retryAfterMs: 85000,
      });
    } finally {
      fetch.mockRestore();
    }
  });
});
