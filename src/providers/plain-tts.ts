import { hasSpokenContent } from './tts-spoken-content';
import type { Paragraph, SpokenTextRule } from '../domain/types';
import { projectSpokenText } from '@boaa/text-core/spoken-text';
import { integrityHash, structuredIntegrityHash } from '@boaa/text-core/hash';
import type { PlayableTtsSegment } from './tts-playback';
import type { TTSVoice } from './tts';

export interface PlainTTSVoice extends TTSVoice {
  providerId?: string;
  providerName?: string;
  modelId?: string;
  paid?: boolean;
}

export interface PlainTTSProviderStatus {
  id: string;
  name: string;
  modelId?: string;
  available: boolean;
  paid: boolean;
  message?: string;
}

export interface PlainTTSVoices {
  /** Empty means the default engine is unavailable; never choose a different paid engine implicitly. */
  defaultVoiceId?: string;
  available: boolean;
  modelId?: string;
  revision?: string;
  voices: PlainTTSVoice[];
  providers?: PlainTTSProviderStatus[];
  message?: string;
}

export interface PlainTTSRequest {
  voiceId: string;
  modelRevision: string;
  rate: number;
  paragraphId: string;
  paragraphHash: string;
  contentRevision?: string;
  chunkHash: string;
  chunking?: 'sentence' | 'paragraph' | 'batch';
  batch?: readonly { paragraphId: string; paragraphHash: string }[];
  rules: readonly SpokenTextRule[];
}

export const PLAIN_TTS_SAMPLE = '안녕하세요. BOAA 리더입니다. 선택한 목소리로 지금 읽고 있는 이야기를 들려드릴게요.';

/** The same deterministic projection runs in the reader and on the server. No AI artifacts. */
export function buildPlainTTSItems(input: {
  paragraph: Paragraph;
  language?: string;
  rules?: readonly SpokenTextRule[];
  rate: number;
  voiceURI?: string;
  chunking?: 'sentence' | 'paragraph' | 'batch';
}): PlayableTtsSegment[] {
  const { paragraph } = input;
  const projection = projectSpokenText({
    text: paragraph.text,
    semantics: paragraph.inlineSemantics,
    rules: input.rules,
    language: input.language,
    rubyPolicy: 'reading',
    footnotePolicy: 'skip_marker',
  });
  const items: PlayableTtsSegment[] = [];
  // Bound synthesis latency even for an entire chapter imported as one paragraph.
  const chunks = projection.spokenText.matchAll(
    input.chunking === 'paragraph' || input.chunking === 'batch'
      ? /[\s\S]{1,700}/gu
      : /[^.!?…。！？\n]{1,240}(?:[.!?…。！？]+["'”’」』》)]*|\n+|$)|[^.!?…。！？\n]{1,240}|[.!?…。！？]+/gu,
  );
  for (const match of chunks) {
    const text = match[0].trim();
    if (!hasSpokenContent(text)) continue;
    const start = match.index + match[0].indexOf(text);
    const end = start + text.length;
    const spans = projection.spans.filter((span) => span.spokenEnd > start && span.spokenStart < end);
    if (!spans.length) continue;
    const sourceStart = (span: (typeof spans)[number]) =>
      span.spokenEnd - span.spokenStart === span.sourceEnd - span.sourceStart
        ? span.sourceStart + Math.max(0, start - span.spokenStart)
        : span.sourceStart;
    const sourceEnd = (span: (typeof spans)[number]) =>
      span.spokenEnd - span.spokenStart === span.sourceEnd - span.sourceStart
        ? span.sourceEnd - Math.max(0, span.spokenEnd - end)
        : span.sourceEnd;
    const startOffset = Math.min(...spans.map(sourceStart));
    const endOffset = Math.max(...spans.map(sourceEnd));
    items.push({
      paragraphId: paragraph.id,
      text,
      language: input.language,
      sourceText: paragraph.text.slice(startOffset, endOffset),
      spokenTextFingerprint: structuredIntegrityHash({
        version: 'plain-tts-v1',
        start,
        end,
        text,
        startOffset,
        endOffset,
      }),
      speakerId: 'narrator',
      speakerLabel: '기본 목소리',
      emotion: 'neutral',
      rate: input.rate,
      voiceURI: input.voiceURI,
      sourceSegmentIds: [],
      sourceRanges: [{ segmentId: '', paragraphId: paragraph.id, startOffset, endOffset }],
    });
  }
  return items;
}

export function plainTTSParagraphHash(paragraph: Paragraph): string {
  return integrityHash(paragraph.text);
}

export const PLAIN_TTS_BATCH_LIMIT = 700;
export const PLAIN_TTS_BATCH_PARAGRAPHS = 16;

/** Rebuilt from owned source paragraphs on the server; no client-supplied narration text. */
export function buildPlainTTSBatch(input: {
  paragraphs: readonly Paragraph[];
  language?: string;
  rules?: readonly SpokenTextRule[];
  rate: number;
}): PlayableTtsSegment | undefined {
  if (input.paragraphs.length < 2 || input.paragraphs.length > PLAIN_TTS_BATCH_PARAGRAPHS) return;
  const first = input.paragraphs[0];
  if (
    new Set(input.paragraphs.map((p) => p.id)).size !== input.paragraphs.length ||
    input.paragraphs.some(
      (p, index) =>
        p.chapterId !== first.chapterId ||
        p.novelId !== first.novelId ||
        (index > 0 && p.index <= input.paragraphs[index - 1].index),
    )
  )
    return;
  const parts = input.paragraphs.map((paragraph) => buildPlainTTSItems({ ...input, paragraph, chunking: 'paragraph' }));
  // Do not silently consume skipped paragraphs or split a paragraph within a batch.
  if (parts.some((items) => items.length !== 1)) return;
  const text = parts.map((items) => items[0].text).join('\n\n');
  if ([...text].length > PLAIN_TTS_BATCH_LIMIT) return;
  const plainBatch = input.paragraphs.map((p) => ({ paragraphId: p.id, paragraphHash: plainTTSParagraphHash(p) }));
  return {
    ...parts[0][0],
    text,
    sourceText: undefined,
    plainBatch,
    plainBatchPositions: input.paragraphs.map((paragraph, index) => ({
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index - 1,
      spokenLength: [...parts[index][0].text].length,
    })),
    spokenTextFingerprint: structuredIntegrityHash({
      version: 'plain-tts-batch-v1',
      plainBatch,
      parts: parts.map((p) => p[0].spokenTextFingerprint),
      text,
    }),
    sourceRanges: parts.flatMap((items) => items[0].sourceRanges),
  };
}

export async function preparePlainTTSBatch(input: {
  index: number;
  paragraph: Paragraph;
  paragraphCount: number;
  getParagraph(index: number): Promise<Paragraph | undefined>;
  language?: string;
  rules?: readonly SpokenTextRule[];
  rate: number;
  shouldContinue(): boolean;
}): Promise<{ playables: PlayableTtsSegment[]; nextParagraphIndex: number }> {
  const paragraphs = [input.paragraph];
  let batch: PlayableTtsSegment | undefined;
  let nextParagraphIndex = input.index + 1;
  for (
    let index = input.index + 1;
    index < input.paragraphCount && index < input.index + 64 && paragraphs.length < PLAIN_TTS_BATCH_PARAGRAPHS;
    index++
  ) {
    if (!input.shouldContinue()) break;
    const next = await input.getParagraph(index);
    if (!next || !input.shouldContinue()) break;
    if (!hasSpokenContent(next.text)) {
      nextParagraphIndex = index + 1;
      continue;
    }
    const candidate = buildPlainTTSBatch({ ...input, paragraphs: [...paragraphs, next] });
    if (!candidate) break;
    paragraphs.push(next);
    batch = candidate;
    nextParagraphIndex = index + 1;
  }
  return {
    playables: batch ? [batch] : buildPlainTTSItems({ ...input, chunking: 'paragraph' }),
    nextParagraphIndex,
  };
}
