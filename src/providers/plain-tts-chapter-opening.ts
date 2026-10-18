import { hasSpokenContent } from './tts-spoken-content';
import type { ParagraphPage, Paragraph, SpokenTextRule, TTSPlaybackSettings } from '../domain/types';
import { buildPlainTTSItems, preparePlainTTSBatch } from './plain-tts';
import { planEpubFootnotePlayback } from './epub-footnote-playback';

/** Prepare only the first playable chunk; never synthesize an entire speculative chapter. */
export async function preparePlainTTSChapterOpening(input: {
  paragraphs: readonly Paragraph[];
  epub: boolean;
  settings: TTSPlaybackSettings;
  rules: readonly SpokenTextRule[];
  language?: string;
  shouldContinue(): boolean;
}) {
  const paragraphs = input.epub
    ? planEpubFootnotePlayback({ paragraphs: input.paragraphs, startIndex: 0, policy: input.settings.footnotePlayback })
        .paragraphs
    : input.paragraphs;
  for (let index = 0; index < paragraphs.length && input.shouldContinue(); index++) {
    const paragraph = paragraphs[index];
    if (!hasSpokenContent(paragraph.text)) continue;
    const playables =
      input.settings.plainChunking === 'batch'
        ? (
            await preparePlainTTSBatch({
              index,
              paragraph,
              paragraphCount: paragraphs.length,
              getParagraph: async (i) => paragraphs[i],
              language: input.language,
              rules: input.rules,
              rate: input.settings.rate,
              shouldContinue: input.shouldContinue,
            })
          ).playables
        : buildPlainTTSItems({
            paragraph,
            language: input.language,
            rules: input.rules,
            rate: input.settings.rate,
            chunking: input.settings.plainChunking,
          });
    if (input.shouldContinue() && playables[0]) return { paragraph, playable: playables[0] };
  }
}

/** Stored paragraph ordinals are one-based; playback/virtualizer indices are zero-based. */
export function paragraphAtPlaybackIndex(page: ParagraphPage | undefined, index: number) {
  return page?.paragraphs.find((paragraph) => paragraph.index === index + 1);
}
