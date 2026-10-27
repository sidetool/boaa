import { describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { speakerInputPdf } from './speaker-input-pdf';
import { normalizeSpeakerEngine, speakerRevision, castingRevision } from './speaker-engine-config';
import { SpeakerEngineTransport } from './speaker-engine-transport';

const signal = () => new AbortController().signal;
async function extract(pdf: Buffer) {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent({ disableNormalization: true });
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
const config = normalizeSpeakerEngine({
  name: 'Fixture',
  engineUrl: 'http://engine.test',
  protocol: 'gemini',
  url: 'https://model.test/v1beta',
  modelId: 'chosen-model',
  maxOutputTokens: 4096,
  paid: true,
  enabled: true,
});
describe('native-text PDF model input', () => {
  it('round-trips Korean, CJK, supplementary characters, quotes, IDs and PDF syntax through a real PDF parser', async () => {
    const text = '구간-001 “안녕하세요.” 日本語 中文 😀 𠀀 \\ ( ) <script> /endstream\nID=002, start=153 end=180';
    const pdf = await speakerInputPdf(text, signal());
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7');
    const pages = await extract(pdf);
    expect(pages).toHaveLength(1);
    expect(pages.join('').replaceAll(' ', '')).toBe(text.replace(/[\n ]/g, ''));
  });
  it('preserves every boundary character across wrapping and multiple pages, including the final page', async () => {
    const lines = Array.from({ length: 835 }, (_, i) => `문단${String(i).padStart(4, '0')}끝`);
    lines[412] = '가'.repeat(1179) + '😀' + '마지막';
    const pages = await extract(await speakerInputPdf(lines.join('\n'), signal()));
    expect(pages).toHaveLength(2);
    expect(pages.join('').replaceAll(' ', '')).toBe(lines.join(''));
    expect(pages.at(-1)).toContain('문단0834끝');
  });
  it('bounds input/pages, rejects malformed Unicode, and observes pre-abort and cancellation during compression', async () => {
    for (const text of ['', 'a'.repeat(500001), '\ud800', '\n'.repeat(830 * 64)])
      await expect(speakerInputPdf(text, signal())).rejects.toMatchObject({ statusCode: 413 });
    const c = new AbortController();
    c.abort();
    await expect(speakerInputPdf('source', c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const later = new AbortController();
    const pending = speakerInputPdf('source'.repeat(20000), later.signal);
    later.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('keeps semantic revisions stable across encoding changes so cached analysis and paused jobs remain reusable', () => {
    const pdf = normalizeSpeakerEngine({ ...config, inputFormat: 'pdf' });
    for (const revision of [speakerRevision, castingRevision]) {
      expect(revision(normalizeSpeakerEngine(config))).toBe(revision(config));
      expect(revision(pdf)).toBe(revision(config));
      expect(revision({ ...pdf, name: 'renamed', apiKey: 'rotated' })).toBe(revision(pdf));
    }
    for (const patch of [{ inputFormat: true }, { inputFormat: 'image' }, { protocol: 'openai', inputFormat: 'pdf' }])
      expect(() => normalizeSpeakerEngine({ ...config, ...patch })).toThrow();
  });
  it('sends a single PDF instead of duplicate source text, retaining instructions, schema and selected settings', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"labels":[]}' }] } }] }),
    );
    const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    const prompt = '원문-ID-17 “원본 대사”';
    const request = { prompt, schema: { type: 'object' } };
    expect(
      await t.generateJson({ ...config, inputFormat: 'pdf', reasoning: 'high' }, request, signal(), 'Select voices.'),
    ).toBe('{"labels":[]}');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.systemInstruction.parts[0].text).toContain('Select voices.');
    expect(body.systemInstruction.parts[0].text).toContain('"type":"object"');
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'high' } });
    const parts = body.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe('application/pdf');
    expect((await extract(Buffer.from(parts[0].inlineData.data, 'base64'))).join('')).toBe(prompt);
    expect(JSON.stringify(body)).not.toContain(prompt);
    await t.generateJson(config, request, signal(), 'Select voices.');
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).contents[0].parts).toEqual([{ text: prompt }]);
  });
  it('does not silently resend plain text on PDF failures or provider rate limits', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    const v = { ...config, inputFormat: 'pdf' as const };
    await expect(t.generateJson(v, { prompt: 'a'.repeat(500001), schema: {} }, signal(), '')).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(t.generateJson(v, { prompt: '본문', schema: {} }, signal(), '')).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 30,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
