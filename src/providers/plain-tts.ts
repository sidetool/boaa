import type { Paragraph, SpokenTextRule } from '../domain/types';
import { projectSpokenText } from '@boaa/text-core/spoken-text';
import { integrityHash, structuredIntegrityHash } from '@boaa/text-core/hash';
import type { PlayableTtsSegment } from './tts-playback';
import type { TTSVoice } from './tts';

export interface PlainTTSVoices {
  available: boolean;
  modelId?: string;
  revision?: string;
  voices: TTSVoice[];
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
    /[^.!?…。！？\n]{1,240}(?:[.!?…。！？]+["'”’」』》)]*|\n+|$)|[^.!?…。！？\n]{1,240}|[.!?…。！？]+/gu,
  );
  for (const match of chunks) {
    const text = match[0].trim();
    if (!text) continue;
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
