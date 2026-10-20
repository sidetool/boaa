import { describe, expect, it, vi } from 'vitest';
import { TranslationClient } from './translation-client';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import { DEFAULT_TRANSLATION_SETTINGS } from '../../translation/contracts';

describe('translation transport', () => {
  it('uses the API base exactly once and does not leak keys into a URL', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    try {
      const client = new TranslationClient(new RemoteApiClient('https://synthetic.example/api'));
      await client.credential('gemini', 'synthetic-secret');
      expect(fetch.mock.calls[0][0]).toBe('https://synthetic.example/api/translation/credentials/gemini');
      expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ value: 'synthetic-secret' }));
      expect(String(fetch.mock.calls[0][0])).not.toContain('synthetic-secret');
    } finally {
      fetch.mockRestore();
    }
  });
  it('saving settings includes optimistic revision; lookup explicitly cannot create jobs', async () => {
    const request = vi.fn().mockResolvedValue({ result: null });
    const client = new TranslationClient({ request });
    await client.save(DEFAULT_TRANSLATION_SETTINGS, 5);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ revision: 5, settings: { enabled: false } });
    await client.request({ workKey: 'book', chapterKey: 'chapter', lookupOnly: true });
    expect(JSON.parse(request.mock.calls[1][1].body).lookupOnly).toBe(true);
  });
});
