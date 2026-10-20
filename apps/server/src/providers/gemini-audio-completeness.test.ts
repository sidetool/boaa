import { wavFromPcm16 } from './tts-audio.js';
import { interactionAudioResponse } from './gemini-audio-response.js';
import { describe, expect, it, vi } from 'vitest';
import { createGeminiVertexTTSGenerateContentClient } from './gemini-vertex-tts-provider.js';
const sdk = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: sdk.generate };
  },
}));
const input = {
  modelId: 'gemini-3.8-flash-lite-tts',
  contents: 'Synthetic first and second paragraph.',
  voice: 'Kore',
  languageCode: 'en-US',
};
const audioPart = (bytes: number[]) => ({
  inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.from(bytes).toString('base64') },
});
async function generate(response: unknown) {
  sdk.generate.mockResolvedValueOnce(response);
  const client = await createGeminiVertexTTSGenerateContentClient({ project: 'fixture', location: 'global' });
  return client.generateAudio(input);
}
describe('Vertex audio completeness', () => {
  it('keeps every audio part of the selected candidate in order', async () => {
    const result = await generate({
      candidates: [
        { finishReason: 'STOP', content: { parts: [audioPart([1, 0]), audioPart([2, 0])] } },
        { finishReason: 'STOP', content: { parts: [audioPart([9, 0])] } },
      ],
    });
    expect([...Buffer.from(result.audio)]).toEqual([1, 0, 2, 0]);
  });
  it.each(['MAX_TOKENS', 'OTHER', 'SAFETY', 'CONTINUATION'])(
    'rejects partial audio with %s instead of completing the batch',
    async (finishReason) => {
      await expect(
        generate({ candidates: [{ finishReason, content: { parts: [audioPart([1, 0])] } }] }),
      ).rejects.toThrow();
    },
  );
});

it('rejects absent completion metadata and mixed audio encodings', async () => {
  await expect(generate({ candidates: [{ content: { parts: [audioPart([1, 0])] } }] })).rejects.toThrow();
  await expect(
    generate({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [audioPart([1, 0]), { inlineData: { mimeType: 'audio/mp3', data: 'AQI=' } }] },
        },
      ],
    }),
  ).rejects.toThrow();
});

it('merges complete WAV parts as audio, not concatenated file headers', async () => {
  const part = (pcm: number[]) => ({
    inlineData: { mimeType: 'audio/wav', data: wavFromPcm16(Buffer.from(pcm), 24000).toString('base64') },
  });
  const response = await generate({
    candidates: [{ finishReason: 'STOP', content: { parts: [part([1, 0]), part([2, 0])] } }],
  });
  expect(Buffer.from(response.audio)).toEqual(wavFromPcm16(Buffer.from([1, 0, 2, 0]), 24000));
  const truncated = wavFromPcm16(Buffer.from([1, 0, 2, 0]), 24000).subarray(0, 46);
  await expect(
    generate({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: truncated.toString('base64') } }] },
        },
      ],
    }),
  ).rejects.toThrow();
});
it('keeps Interaction audio segments and rejects an unfinished interaction', () => {
  const outputs = [
    { type: 'audio', mime_type: 'audio/pcm', data: 'AQA=' },
    { type: 'audio', mime_type: 'audio/pcm', data: 'AgA=' },
  ];
  expect(interactionAudioResponse({ status: 'completed', outputs }).buffer).toEqual(Buffer.from([1, 0, 2, 0]));
  expect(() => interactionAudioResponse({ status: 'incomplete', outputs })).toThrow();
});

it('rejects an empty WAV even when generation reports STOP', async () => {
  await expect(
    generate({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { inlineData: { mimeType: 'audio/wav', data: wavFromPcm16(Buffer.alloc(0), 24000).toString('base64') } },
            ],
          },
        },
      ],
    }),
  ).rejects.toThrow();
});
