import { expect, it } from 'vitest';
import type { Paragraph } from '../domain/types';
import { preparePlainTTSChapterOpening, paragraphAtPlaybackIndex } from './plain-tts-chapter-opening';
import { normalizeTTSPlaybackSettings } from './tts-playback-settings';
import { preparePlainTTSBatch, buildPlainTTSItems } from './plain-tts';
const paragraphs: Paragraph[] = ['다음 화의 첫 문단입니다.', '이어서 읽는 두 번째 문단입니다.'].map((text, index) => ({
  id: `p${index}`,
  novelId: 'book',
  chapterId: 'next',
  index: index + 1,
  text,
  textHash: `hash${index}`,
  startOffsetInChapter: 0,
  endOffsetInChapter: text.length,
}));
it('prepares the exact same first batch as foreground playback, one audio only', async () => {
  const settings = normalizeTTSPlaybackSettings({ plainChunking: 'batch' });
  const opening = await preparePlainTTSChapterOpening({
    paragraphs,
    epub: false,
    settings,
    rules: [],
    shouldContinue: () => true,
  });
  const foreground = await preparePlainTTSBatch({
    index: 0,
    paragraph: paragraphs[0],
    paragraphCount: 2,
    getParagraph: async (i) => paragraphs[i],
    rate: settings.rate,
    rules: [],
    shouldContinue: () => true,
  });
  expect(opening?.playable).toEqual(foreground.playables[0]);
  expect(opening?.playable.plainBatch).toHaveLength(2);
});
it('preserves sentence mode and EPUB footnote ordering and observes cancellation', async () => {
  const settings = normalizeTTSPlaybackSettings({ plainChunking: 'sentence', footnotePlayback: 'skip' });
  const opening = await preparePlainTTSChapterOpening({
    paragraphs: [{ ...paragraphs[1], documentPageType: 'footnote' }, paragraphs[0]],
    epub: true,
    settings,
    rules: [],
    shouldContinue: () => true,
  });
  expect(opening?.playable).toEqual(
    buildPlainTTSItems({ paragraph: paragraphs[0], rules: [], rate: settings.rate, chunking: 'sentence' })[0],
  );
  expect(
    await preparePlainTTSChapterOpening({ paragraphs, epub: false, settings, rules: [], shouldContinue: () => false }),
  ).toBeUndefined();
});

it('maps real one-based stored paragraph ordinals to zero-based playback indices, including page boundaries', () => {
  const page = {
    id: 'page',
    novelId: 'book',
    chapterId: 'next',
    pageIndex: 1,
    startParagraphIndex: 101,
    endParagraphIndex: 102,
    textHash: 'page-hash',
    paragraphs: paragraphs.map((p, i) => ({ ...p, index: 101 + i })),
  };
  expect(paragraphAtPlaybackIndex(page, 100)?.index).toBe(101);
  expect(paragraphAtPlaybackIndex(page, 101)?.index).toBe(102);
  expect(paragraphAtPlaybackIndex(page, 99)).toBeUndefined();
  expect(paragraphAtPlaybackIndex(undefined, 0)).toBeUndefined();
});
