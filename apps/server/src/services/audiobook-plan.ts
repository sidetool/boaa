import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { Paragraph } from '@boaa/contracts';
import type { AudiobookInput, AudiobookEstimate } from '../../../../src/providers/plain-audiobook';
import {
  buildPlainTTSItems,
  preparePlainTTSBatch,
  plainTTSParagraphHash,
  type PlainTTSRequest,
  type PlainTTSVoices,
} from '../../../../src/providers/plain-tts';
import { planEpubFootnotePlayback } from '../../../../src/providers/epub-footnote-playback';
import { hasSpokenContent } from '../../../../src/providers/tts-spoken-content';
import type { PlayableTtsSegment } from '../../../../src/providers/tts-playback';

export const audiobookError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
export interface AudiobookPlanItem {
  chapterId: string;
  chapterTitle: string;
  request: Omit<PlainTTSRequest, 'rules'>;
  paragraphIndex: number;
  nextParagraphIndex: number;
  playable: PlayableTtsSegment;
}
export interface AudiobookPlan {
  bookId: string;
  title: string;
  revision: string | null;
  settings: AudiobookInput;
  estimate: AudiobookEstimate;
  items: AudiobookPlanItem[];
}

export function validateAudiobookInput(input: AudiobookInput): void {
  if (
    !input ||
    !Array.isArray(input.chapterIds) ||
    !input.chapterIds.length ||
    input.chapterIds.length > 2000 ||
    input.chapterIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
    new Set(input.chapterIds).size !== input.chapterIds.length ||
    typeof input.voiceId !== 'string' ||
    !input.voiceId ||
    input.voiceId.length > 512 ||
    typeof input.modelRevision !== 'string' ||
    input.modelRevision.length > 256 ||
    !['sentence', 'paragraph', 'batch'].includes(input.chunking) ||
    !['skip', 'immediate', 'end_of_chapter'].includes(input.footnotePlayback) ||
    !Array.isArray(input.rules) ||
    input.rules.length > 100 ||
    (input.batchCharacters !== undefined &&
      (!Number.isInteger(input.batchCharacters) || input.batchCharacters < 200 || input.batchCharacters > 2000))
  )
    throw audiobookError(400, '회차 범위와 낭독 설정을 확인해 주세요.');
}

export async function planAudiobook(
  pool: pg.Pool,
  userId: string,
  bookId: string,
  settings: AudiobookInput,
  catalog?: PlainTTSVoices,
): Promise<AudiobookPlan> {
  validateAudiobookInput(settings);
  const voice = catalog?.voices.find((v) => v.id === settings.voiceId);
  if (catalog && (!voice || !catalog.available || catalog.revision !== settings.modelRevision))
    throw audiobookError(409, '선택한 목소리가 변경됐습니다. 음성 목록을 다시 불러와 주세요.');
  const book = (
    await pool.query(
      'select title,language,format,active_content_revision_id from library_books where id=$1 and user_id=$2 and deleted_at is null',
      [bookId, userId],
    )
  ).rows[0];
  if (!book) throw audiobookError(404, '작품을 찾을 수 없습니다.');
  if (!['txt', 'markdown', 'epub'].includes(book.format))
    throw audiobookError(400, '현재 텍스트·EPUB 작품을 오디오북으로 저장할 수 있어요.');
  const chapters = (
    await pool.query(
      'select id,title from chapters where book_id=$1 and id=any($2::text[]) order by chapter_index,id',
      [bookId, settings.chapterIds],
    )
  ).rows;
  if (chapters.length !== settings.chapterIds.length)
    throw audiobookError(409, '회차 목록이 변경됐습니다. 다시 선택해 주세요.');
  const items: AudiobookPlanItem[] = [];
  let characters = 0;
  let planBytes = 0;
  let sourceBytes = 0;
  for (const chapter of chapters) {
    const bounds = (
      await pool.query(
        'select coalesce(sum(octet_length(text)),0) as bytes from paragraph_search where book_id=$1 and chapter_id=$2',
        [bookId, chapter.id],
      )
    ).rows[0];
    sourceBytes += Number(bounds.bytes);
    if (Number(bounds.bytes) > 32 * 1024 * 1024 || sourceBytes > 96 * 1024 * 1024)
      throw audiobookError(413, '한 번에 만들 본문 범위를 줄여 주세요.');
    const rows = (
      await pool.query(
        'select paragraph,text,paragraph_id,paragraph_index from paragraph_search where book_id=$1 and chapter_id=$2 order by paragraph_index limit 50001',
        [bookId, chapter.id],
      )
    ).rows;
    if (rows.length > 50000) throw audiobookError(413, '회차가 너무 큽니다. 원문을 나누어 주세요.');
    if (!rows.length) throw audiobookError(409, '본문이 아직 준비되지 않은 회차가 있습니다.');
    let paragraphs: readonly Paragraph[] = rows.map((r) => ({
      ...r.paragraph,
      text: r.text,
      id: r.paragraph_id,
      index: r.paragraph_index,
      novelId: bookId,
      chapterId: chapter.id,
    }));
    if (book.format === 'epub')
      paragraphs = planEpubFootnotePlayback({
        paragraphs,
        startIndex: 0,
        policy: settings.footnotePlayback,
      }).paragraphs;
    for (let index = 0; index < paragraphs.length;) {
      const paragraph = paragraphs[index];
      if (!hasSpokenContent(paragraph.text)) {
        index++;
        continue;
      }
      const common = {
        paragraph,
        language: book.language,
        rules: settings.rules,
        rate: 1,
        batchCharacters: settings.batchCharacters,
      };
      const prepared =
        settings.chunking === 'batch'
          ? await preparePlainTTSBatch({
              ...common,
              index,
              paragraphCount: paragraphs.length,
              getParagraph: async (i) => paragraphs[i],
              shouldContinue: () => true,
            })
          : {
              playables: buildPlainTTSItems({ ...common, chunking: settings.chunking }),
              nextParagraphIndex: index + 1,
            };
      for (const playable of prepared.playables) {
        characters += [...playable.text].length;
        if (characters > 20_000_000 || items.length >= 100_000)
          throw audiobookError(413, '한 번에 만들 범위를 줄여 주세요.');
        items.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          paragraphIndex: paragraph.index - 1,
          nextParagraphIndex:
            (paragraphs[prepared.nextParagraphIndex]?.index ?? paragraphs[paragraphs.length - 1].index + 1) - 1,
          playable,
          request: {
            voiceId: settings.voiceId,
            modelRevision: settings.modelRevision,
            rate: 1,
            paragraphId: paragraph.id,
            paragraphHash: plainTTSParagraphHash(paragraph),
            contentRevision: book.active_content_revision_id ?? undefined,
            chunkHash: playable.spokenTextFingerprint!,
            chunking: settings.chunking,
            batchCharacters: settings.chunking === 'batch' ? settings.batchCharacters : undefined,
            batch: playable.plainBatch,
          },
        });
        planBytes += Buffer.byteLength(JSON.stringify(items[items.length - 1].request));
        if (planBytes > 32 * 1024 * 1024) throw audiobookError(413, '한 번에 만들 회차 범위를 줄여 주세요.');
      }
      index = prepared.nextParagraphIndex;
    }
  }
  if (!items.length) throw audiobookError(400, '선택한 범위에 낭독할 본문이 없습니다.');
  const normalized = { ...settings, model: voice?.model ?? settings.model, chapterIds: chapters.map((c) => c.id) };
  const fingerprint = structuredIntegrityHash({
    userId,
    bookId,
    revision: book.active_content_revision_id,
    settings: normalized,
    items: items.map(({ chapterId, request }) => ({ chapterId, request })),
  });
  return {
    bookId,
    title: book.title,
    revision: book.active_content_revision_id,
    settings: normalized,
    items,
    estimate: {
      fingerprint,
      chapterCount: chapters.length,
      itemCount: items.length,
      characters,
      voiceLabel: voice?.label ?? settings.voiceId,
      providerName: voice?.providerName ?? '서버 음성',
      paid: voice?.paid === true,
      firstChapterTitle: chapters[0].title,
      lastChapterTitle: chapters[chapters.length - 1].title,
    },
  };
}
