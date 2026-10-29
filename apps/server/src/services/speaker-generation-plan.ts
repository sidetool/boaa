import { isGeminiVoiceDesignModel } from '../../../../src/providers/voice-library';
import {
  parsePerformance,
  isGeminiActingModel,
  NEUTRAL_PERFORMANCE,
  type SpeakerPerformance,
} from '../../../../src/providers/tts-performance';
import type pg from 'pg';
import type { Paragraph, SpokenTextRule } from '@boaa/contracts';
import { structuredIntegrityHash, textIntegrityHash } from '@boaa/text-core/hash';
import {
  buildPlainTTSItems,
  plainTTSParagraphHash,
  type PlainTTSModel,
  type PlainTTSRequest,
  type PlainTTSVoices,
} from '../../../../src/providers/plain-tts';
import type { SpeakerGenerationInput, SpeakerGenerationEstimate } from '../../../../src/providers/speaker-generation';
import type { SpeakerChapter, SpeakerLabel, SpeakerIdentity } from '../../../../src/providers/speaker-engine-protocol';
import type { AudiobookPlan } from './audiobook-plan.js';
import { audiobookError } from './audiobook-plan.js';
import type { SpeakerEngineStore } from '../providers/speaker-engine-store.js';
import { speakerRevision, castingRevision } from '../providers/speaker-engine-config.js';
import { normalizeCasting } from './speaker-voice-selection.js';
import type { VoiceLibraryStore } from './voice-library-store.js';
import type { PlayableTtsSegment } from '../../../../src/providers/tts-playback';

export interface CastRequest extends Omit<PlainTTSRequest, 'rules'> {
  cast: {
    start: number;
    end: number;
    part: number;
    speakerId: string;
    label: string;
    language?: string;
    model: PlainTTSModel;
    instructions?: string;
    performance?: SpeakerPerformance;
    /** Additional contiguous source spans sharing this speaker, voice and delivery. */
    batch?: CastSource[];
  };
}
export interface CastSource {
  paragraphId: string;
  paragraphHash: string;
  chunkHash: string;
  start: number;
  end: number;
  part: number;
}
export function unbatchCastRequest(request: CastRequest): CastRequest[] {
  const { batch, ...cast } = request.cast;
  const first = { ...request, cast };
  return [
    first,
    ...(batch ?? []).map(({ start, end, part, ...source }) => ({
      ...first,
      ...source,
      cast: { ...cast, start, end, part },
    })),
  ];
}
export async function speakerPlan(
  pool: pg.Pool,
  owner: string,
  bookId: string,
  input: SpeakerGenerationInput,
  catalog: PlainTTSVoices,
  engines: SpeakerEngineStore,
  library?: VoiceLibraryStore,
): Promise<{ plan: AudiobookPlan; estimate: SpeakerGenerationEstimate }> {
  if (
    !input ||
    (input.batchAudio !== undefined && typeof input.batchAudio !== 'boolean') ||
    (input.autoActing !== undefined && typeof input.autoActing !== 'boolean') ||
    !Array.isArray(input.chapterIds) ||
    !input.chapterIds.length ||
    input.chapterIds.length > 500 ||
    new Set(input.chapterIds).size !== input.chapterIds.length ||
    input.chapterIds.some((id) => typeof id !== 'string' || id.length > 256) ||
    typeof input.engineId !== 'string' ||
    typeof input.narratorVoiceId !== 'string' ||
    !Array.isArray(input.characterVoiceIds) ||
    !input.characterVoiceIds.length ||
    input.characterVoiceIds.length > 32 ||
    input.characterVoiceIds.some((id) => typeof id !== 'string') ||
    new Set(input.characterVoiceIds).size !== input.characterVoiceIds.length ||
    !['skip', 'immediate', 'end_of_chapter'].includes(input.footnotePlayback)
  )
    throw audiobookError(400, '생성 범위와 목소리를 확인해 주세요.');
  const book = (
    await pool.query('select * from library_books where id=$1 and user_id=$2 and deleted_at is null', [bookId, owner])
  ).rows[0];
  if (!book || !['txt', 'markdown', 'epub'].includes(book.format))
    throw audiobookError(404, '텍스트 작품을 찾을 수 없어요.');
  const chapters = (
    await pool.query('select id,title,chapter_index from chapters where book_id=$1 order by chapter_index,id', [bookId])
  ).rows;
  const selected = chapters.filter((c) => input.chapterIds.includes(c.id));
  if (selected.length !== input.chapterIds.length) throw audiobookError(409, '회차 목록이 변경됐어요.');
  const last = chapters.findIndex((c) => c.id === selected[selected.length - 1].id);
  if (last >= 500) throw audiobookError(413, '실험 기능은 앞에서부터 500회차까지 분석할 수 있어요.');
  const context = chapters.slice(0, last + 1);
  const size = (
    await pool.query(
      'select chapter_id,sum(length(text))::bigint n,count(*)::int p from paragraph_search where book_id=$1 and chapter_id=any($2::text[]) group by chapter_id',
      [bookId, context.map((c) => c.id)],
    )
  ).rows;
  if (size.length !== context.length || size.some((r) => Number(r.n) > 120000 || r.p > 10000))
    throw audiobookError(413, '본문이 없거나 한 회차가 너무 커서 분석할 수 없어요.');
  const analysisCharacters = size.reduce((n, r) => n + Number(r.n), 0);
  const characters = size.filter((r) => input.chapterIds.includes(r.chapter_id)).reduce((n, r) => n + Number(r.n), 0);
  if (analysisCharacters > 20_000_000) throw audiobookError(413, '한 번에 분석할 범위를 줄여 주세요.');
  const voiceIds = [...new Set([input.narratorVoiceId, ...input.characterVoiceIds])];
  const voices = voiceIds.map((id) => catalog.voices.find((v) => v.id === id));
  if (voices.some((v) => !v?.model) || !catalog.available)
    throw audiobookError(409, '선택한 서버 목소리를 다시 확인해 주세요.');
  if (input.autoActing && voices.some((v) => v?.autoActingSupported !== true))
    throw audiobookError(400, '자동 연출은 지원되는 Gemini 3.8 TTS 목소리로만 사용할 수 있어요.');
  const engine = await engines.load(input.engineId);
  if (engine.purpose === 'casting') throw audiobookError(400, '화자 분석에는 분석용 모델 연결을 골라 주세요.');
  const casting = normalizeCasting(input.casting);
  const selecting = casting?.engineId ? await engines.loadCasting(casting.engineId) : undefined;
  const designer = casting?.autoDesign
    ? (await library?.list())?.designers.find((d) => d.id === casting.designProviderId)
    : undefined;
  if (casting?.autoDesign && !designer)
    throw audiobookError(400, '설명으로 목소리를 만들 수 있는 TTS 연결을 골라 주세요.');
  const designModel = casting?.autoDesign
    ? catalog.voices.find((v) => v.providerId === casting.designProviderId)?.model
    : undefined;
  if (casting?.autoDesign && !designModel) throw audiobookError(409, '목소리를 만들 TTS 모델을 확인해 주세요.');
  if (
    input.autoActing &&
    casting?.autoDesign &&
    (!isGeminiActingModel(casting.designModelId) ||
      !catalog.voices.some((v) => v.providerId === casting.designProviderId && v.autoActingSupported))
  )
    throw audiobookError(400, '자동 연기를 지원하는 Gemini 3.8 연결에서 새 목소리를 만들어 주세요.');
  if (
    casting?.designMode === 'characters' &&
    (!isGeminiVoiceDesignModel(casting.designModelId) ||
      !isGeminiVoiceDesignModel(designer?.modelId) ||
      !isGeminiVoiceDesignModel(voices[0]?.model?.modelId) ||
      voices[0]?.providerId !== casting.designProviderId ||
      !isGeminiVoiceDesignModel(designModel?.modelId))
  )
    throw audiobookError(400, '새 목소리 제작은 Gemini 3.8 Flash TTS 연결에서 사용할 수 있어요.');
  const capabilities = await engines.transport.capabilities(engine, AbortSignal.timeout(15000));
  if (input.autoActing && !capabilities.performanceAnnotations)
    throw audiobookError(409, '화자 분석 서비스를 업데이트하면 자동 연출을 사용할 수 있어요.');
  const analysisKey = structuredIntegrityHash({
    book: bookId,
    revision: book.active_content_revision_id,
    engine: speakerRevision(engine),
    version: capabilities.engineVersion,
  });
  const models = Object.fromEntries(voices.map((v) => [v!.id, v!.model!]));
  const settings = {
    chapterIds: selected.map((c) => c.id),
    voiceId: input.narratorVoiceId,
    modelRevision: catalog.revision!,
    chunking: 'paragraph' as const,
    rules: input.rules,
    footnotePlayback: input.footnotePlayback,
    cast: {
      voiceEvidenceVersion: 2 as const,
      ...(input.batchAudio === true ? { batchAudio: true } : {}),
      ...(input.autoActing
        ? { autoActing: true, actingEngine: { id: input.engineId, revision: speakerRevision(engine) } }
        : {}),
      language: book.language ?? undefined,
      engineId: input.engineId,
      engineRevision: speakerRevision(engine),
      engineVersion: capabilities.engineVersion,
      characterVoiceIds: input.characterVoiceIds,
      models,
      ...(casting
        ? { casting: { ...casting, engineRevision: selecting ? castingRevision(selecting) : undefined, designModel } }
        : {}),
    },
  };
  const fingerprint = structuredIntegrityHash({
    book: bookId,
    revision: book.active_content_revision_id,
    analysisKey,
    pinnedVoices: library
      ? (
          await pool.query(
            'select speaker_id,voice_id from speaker_voice_bindings where user_id=$1 and book_id=$2 and analysis_key=$3 and pinned order by speaker_id',
            [owner, bookId, analysisKey],
          )
        ).rows
      : undefined,
    settings: { ...settings, modelRevision: undefined },
  });
  const estimate: SpeakerGenerationEstimate = {
    fingerprint,
    chapterCount: selected.length,
    contextChapterCount: context.length - selected.length,
    characters,
    modelLabel: engine.modelId,
    voiceLabel: '화자별 목소리',
    selectionModelLabel: selecting?.modelId,
    maxDesignedVoices: casting?.autoDesign ? casting.maxDesignedVoices : undefined,
    paid: engine.paid || voices.some((v) => v!.paid) || !!selecting?.paid || !!designer?.paid,
  };
  return {
    estimate,
    plan: {
      bookId,
      title: book.title,
      revision: book.active_content_revision_id,
      settings,
      planningComplete: false,
      speakerRun: { analysisKey, chapterIds: context.map((c) => c.id) },
      items: [],
      estimate: {
        ...estimate,
        itemCount: 0,
        providerName: engine.name,
        firstChapterTitle: selected[0].title,
        lastChapterTitle: selected[selected.length - 1].title,
      },
    },
  };
}
export async function loadSpeakerChapter(
  pool: Pick<pg.Pool, 'query'>,
  owner: string,
  bookId: string,
  chapterId: string,
  index: number,
): Promise<{ chapter: SpeakerChapter; paragraphs: Paragraph[] }> {
  const row = (
    await pool.query(
      'select c.title from chapters c join library_books b on b.id=c.book_id where c.id=$1 and b.id=$2 and b.user_id=$3 and b.deleted_at is null',
      [chapterId, bookId, owner],
    )
  ).rows[0];
  if (!row) throw audiobookError(409, '회차가 변경됐어요.');
  const rows = (
    await pool.query(
      'select paragraph_id,paragraph_index,paragraph,text from paragraph_search where book_id=$1 and chapter_id=$2 order by paragraph_index limit 10001',
      [bookId, chapterId],
    )
  ).rows;
  if (!rows.length || rows.length > 10000 || rows.reduce((n, r) => n + r.text.length, 0) > 120000)
    throw audiobookError(413, '본문 크기를 확인해 주세요.');
  const paragraphs = rows.map((r) => ({
    ...r.paragraph,
    id: r.paragraph_id,
    index: r.paragraph_index,
    text: r.text,
    chapterId,
    novelId: bookId,
  })) as Paragraph[];
  return {
    chapter: {
      id: chapterId,
      index,
      title: row.title,
      paragraphs: paragraphs.map((p) => ({ id: p.id, index: p.index, text: p.text })),
    },
    paragraphs,
  };
}
function sourceSlice(p: Paragraph, start: number, end: number): Paragraph {
  return {
    ...p,
    text: p.text.slice(start, end),
    inlineSemantics: p.inlineSemantics
      ?.filter((s) => s.start >= start && s.end <= end)
      .map((s) => ({ ...s, start: s.start - start, end: s.end - start })),
  };
}
export function castPlayable(
  source: Paragraph | readonly Paragraph[],
  request: CastRequest,
  rules: readonly SpokenTextRule[],
): PlayableTtsSegment {
  const paragraphs: readonly Paragraph[] = Array.isArray(source) ? source : [source as Paragraph];
  const paragraph = paragraphs.find((p) => p.id === request.paragraphId);
  if (!paragraph) throw audiobookError(409, '본문이 변경됐어요.');
  if (request.cast.batch) {
    if (!request.cast.batch.length || request.cast.batch.length > 15)
      throw audiobookError(409, '묶음 낭독 위치가 올바르지 않아요.');
    const requests = unbatchCastRequest(request);
    const parts = requests.map((r) => castPlayable(paragraphs, r, rules));
    const positions: { paragraphId: string; paragraphIndex: number; spokenLength: number }[] = [];
    let text = '';
    for (const [i, part] of parts.entries()) {
      const p = paragraphs.find((p) => p.id === part.paragraphId)!;
      const previous = positions.at(-1);
      if (p.chapterId !== paragraph.chapterId || (previous && p.index - 1 < previous.paragraphIndex))
        throw audiobookError(409, '묶음 낭독 순서가 본문과 일치하지 않아요.');
      if (i && p.id === requests[i - 1].paragraphId) {
        const before = parts[i - 1].sourceRanges.at(-1)!;
        if (part.sourceRanges[0].startOffset < before.endOffset) throw audiobookError(409, '묶음 낭독 위치가 겹쳐요.');
      }
      text += (i ? (previous?.paragraphId === p.id ? ' ' : '\n\n') : '') + part.text;
      if (previous?.paragraphId === p.id) previous.spokenLength += [...part.text].length;
      else positions.push({ paragraphId: p.id, paragraphIndex: p.index - 1, spokenLength: [...part.text].length });
    }
    if ([...text].length > 700) throw audiobookError(409, '묶음 낭독 문장이 너무 길어요.');
    return {
      ...parts[0],
      text,
      sourceText: undefined,
      spokenTextSpans: undefined,
      spokenTextFingerprint: structuredIntegrityHash({
        version: 'cast-batch-1',
        parts: parts.map((p) => p.spokenTextFingerprint),
        text,
      }),
      plainBatchPositions: positions,
      sourceRanges: parts.flatMap((p) => p.sourceRanges),
    };
  }
  const c = request.cast;
  if (
    !c ||
    ![c.start, c.end, c.part].every(Number.isSafeInteger) ||
    c.start < 0 ||
    c.end <= c.start ||
    c.end > paragraph.text.length ||
    c.part < 0 ||
    plainTTSParagraphHash(paragraph) !== request.paragraphHash
  )
    throw audiobookError(409, '화자별 낭독 위치가 본문과 일치하지 않아요.');
  const parts = buildPlainTTSItems({
    paragraph: sourceSlice(paragraph, c.start, c.end),
    language: c.language,
    rules,
    chunking: 'batch',
    batchCharacters: 700,
    rate: 1,
  });
  const item = parts[c.part];
  if (!item || item.spokenTextFingerprint !== request.chunkHash)
    throw audiobookError(409, '화자별 낭독 문장이 변경됐어요.');
  return {
    ...item,
    speakerId: c.speakerId,
    speakerLabel: c.label,
    sourceRanges: item.sourceRanges.map((r) => ({
      ...r,
      startOffset: r.startOffset + c.start,
      endOffset: r.endOffset + c.start,
    })),
    spokenTextSpans: item.spokenTextSpans?.map((s) => ({
      ...s,
      sourceStart: s.sourceStart + c.start,
      sourceEnd: s.sourceEnd + c.start,
    })),
  };
}
/** Validate every range and fill all unlabelled narration; an uncertain label never drops the sentence. */
export function castRequests(
  paragraphs: readonly Paragraph[],
  labels: readonly SpeakerLabel[],
  identities: readonly SpeakerIdentity[],
  assignments: Record<string, string>,
  settings: AudiobookPlan['settings'],
): CastRequest[] {
  const cast = settings.cast!;
  if (labels.some((l) => !paragraphs.some((p) => p.id === l.paragraphId)))
    throw audiobookError(502, '분석 결과에 다른 문단이 포함됐어요.');
  const names = new Map(identities.map((i) => [i.id, i.name]));
  const requests: CastRequest[] = [];
  for (const paragraph of paragraphs) {
    const ranges = labels.filter((l) => l.paragraphId === paragraph.id).sort((a, b) => a.startOffset - b.startOffset);
    let cursor = 0;
    const append = (start: number, end: number, speakerId: string, label: string, performance?: SpeakerPerformance) => {
      if (end <= start) return;
      const voiceId = speakerId === 'narrator' ? settings.voiceId : assignments[speakerId];
      if (!voiceId || !cast.models[voiceId]) throw audiobookError(409, '배정한 목소리를 확인해 주세요.');
      const parts = buildPlainTTSItems({
        paragraph: sourceSlice(paragraph, start, end),
        language: cast.language,
        rules: settings.rules,
        chunking: 'batch',
        batchCharacters: 700,
        rate: 1,
      });
      parts.forEach((part, i) =>
        requests.push({
          voiceId,
          rate: 1,
          modelRevision: settings.modelRevision,
          paragraphId: paragraph.id,
          paragraphHash: plainTTSParagraphHash(paragraph),
          chunkHash: part.spokenTextFingerprint!,
          chunking: 'paragraph',
          cast: {
            start,
            end,
            part: i,
            speakerId,
            label,
            language: cast.language,
            model: cast.models[voiceId],
            ...(cast.autoActing && (performance || speakerId === 'narrator')
              ? { performance: parsePerformance(performance ?? NEUTRAL_PERFORMANCE) }
              : {}),
          },
        }),
      );
    };
    for (const l of ranges) {
      if (
        !Number.isSafeInteger(l.startOffset) ||
        !Number.isSafeInteger(l.endOffset) ||
        l.startOffset < cursor ||
        l.endOffset <= l.startOffset ||
        l.endOffset > paragraph.text.length ||
        textIntegrityHash(paragraph.text.slice(l.startOffset, l.endOffset)) !== l.textHash
      )
        throw audiobookError(502, '분석 결과의 본문 위치가 올바르지 않아요.');
      append(cursor, l.startOffset, 'narrator', '내레이터');
      const id = l.reviewRequired || !names.has(l.speakerId) ? 'narrator' : l.speakerId;
      append(
        l.startOffset,
        l.endOffset,
        id,
        names.get(id) ?? '내레이터',
        id === 'narrator' ? NEUTRAL_PERFORMANCE : l.performance,
      );
      cursor = l.endOffset;
    }
    append(cursor, paragraph.text.length, 'narrator', '내레이터');
  }
  return requests;
}
