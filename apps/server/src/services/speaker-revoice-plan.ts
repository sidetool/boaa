import { bookBindingVersions } from './speaker-book-voices';
import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSVoices } from '../../../../src/providers/plain-tts';
import type {
  SpeakerRevoiceInput,
  SpeakerRevoiceSource,
  SpeakerRevoiceEstimate,
} from '../../../../src/providers/speaker-generation';
import { audiobookError, type AudiobookPlan } from './audiobook-plan.js';
import { castPlayable, loadSpeakerChapter, type CastRequest } from './speaker-generation-plan.js';
import { voiceText } from './voice-library-store.js';
import type { SpeakerEngineStore } from '../providers/speaker-engine-store';
import { normalizeCasting } from './speaker-voice-selection';
import type { VoiceLibraryStore } from './voice-library-store';
import { isGeminiVoiceDesignModel } from '../../../../src/providers/voice-library';
import { speakerRevision, castingRevision } from '../providers/speaker-engine-config';

interface Source {
  id: string;
  book_id: string;
  title: string;
  content_revision: string | null;
  settings: AudiobookInput;
  analysis_key: string;
  chapter_ids: string[];
  next_chapter: number;
  total_items: number;
  ledger: unknown;
  assignments: Record<string, string>;
}
interface Item {
  ordinal: number;
  chapter_id: string;
  chapter_title: string;
  request: CastRequest;
}

/** Reads captured, immutable audio plans. It deliberately has no analysis/selection engine dependency. */
export async function loadRevoiceSource(pool: pg.Pool, owner: string, bookId: string, id: string) {
  const source = (
    await pool.query(
      `select a.*,r.analysis_key,r.chapter_ids,r.next_chapter,r.ledger,r.assignments
       from saved_audiobooks a join speaker_generation_runs r on r.audiobook_id=a.id
       join library_books b on b.id=a.book_id
       where a.id=$1 and a.book_id=$2 and a.user_id=$3 and b.user_id=$3 and b.deleted_at is null
       and b.active_content_revision_id is not distinct from a.content_revision
       and a.status in ('paused','failed','completed')
       and not exists(select 1 from self_host_accounts where user_id=$3 and (role<>'admin' or status<>'active'))`,
      [id, bookId, owner],
    )
  ).rows[0] as Source | undefined;
  if (!source?.settings.cast) throw audiobookError(409, '만들기를 멈춘 뒤 같은 본문의 음성을 선택해 주세요.');
  const bounds = (
    await pool.query(
      'select count(*)::int n,coalesce(sum(octet_length(request::text)),0) bytes from saved_audiobook_items where audiobook_id=$1',
      [id],
    )
  ).rows[0];
  if (!bounds.n) throw audiobookError(409, '아직 음성으로 만들 구간이 없어요. 회차 분석이 끝난 뒤 다시 확인해 주세요.');
  if (bounds.n > 100000 || Number(bounds.bytes) > 32 * 1024 * 1024)
    throw audiobookError(413, '다시 만들 음성의 범위가 너무 커요.');
  const items = (
    await pool.query(
      'select ordinal,chapter_id,chapter_title,request from saved_audiobook_items where audiobook_id=$1 order by ordinal',
      [id],
    )
  ).rows as Item[];
  if (items.length !== source.total_items || items.some((item, i) => item.ordinal !== i || !item.request.cast))
    throw audiobookError(409, '음성 구간이 변경됐어요. 다시 확인해 주세요.');
  return { source, items };
}

export function revoiceSourceView(items: readonly Item[]): SpeakerRevoiceSource {
  const voices = new Map<string, SpeakerRevoiceSource['voices'][number]>();
  for (const { request } of items) {
    const { speakerId, label, instructions } = request.cast;
    voices.set(speakerId, {
      speakerId,
      name: label,
      voiceId: request.voiceId,
      instructions,
      itemCount: (voices.get(speakerId)?.itemCount ?? 0) + 1,
    });
  }
  return {
    hasActing: items.some((i) => !!i.request.cast.performance),
    needsActing: items.some((i) => !i.request.cast.performance),
    chapterCount: new Set(items.map((i) => i.chapter_id)).size,
    itemCount: items.length,
    voices: [...voices.values()],
  };
}

export async function planSpeakerRevoice(
  pool: pg.Pool,
  owner: string,
  bookId: string,
  id: string,
  input: SpeakerRevoiceInput,
  catalog: PlainTTSVoices,
  engines?: SpeakerEngineStore,
  library?: VoiceLibraryStore,
): Promise<AudiobookPlan & { estimate: SpeakerRevoiceEstimate }> {
  const { source, items: captured } = await loadRevoiceSource(pool, owner, bookId, id);
  const view = revoiceSourceView(captured);
  const mode = input?.acting?.mode ?? 'preserve';
  if (!['preserve', 'off', 'auto'].includes(mode) || (input?.acting && typeof input.acting !== 'object'))
    throw audiobookError(400, '자동 연기 설정을 확인해 주세요.');
  if (!input || !Array.isArray(input.voices) || input.voices.length !== view.voices.length || input.voices.length > 512)
    throw audiobookError(400, '내레이터와 인물의 목소리를 모두 골라 주세요.');
  const explicit = input.designSpeakerIds;
  if (
    explicit !== undefined &&
    (!Array.isArray(explicit) ||
      !explicit.length ||
      explicit.length > 8 ||
      new Set(explicit).size !== explicit.length ||
      explicit.some(
        (id) => typeof id !== 'string' || id === 'narrator' || !view.voices.some((v) => v.speakerId === id),
      ) ||
      !input.casting)
  )
    throw audiobookError(400, '새 목소리를 만들 인물을 1~8명 선택해 주세요.');
  // Explicit designs replace even unavailable old voices. This Flash voice is only a planning
  // placeholder; every explicit target must finish design before any audio can be synthesized.
  const designPlaceholder = explicit
    ? catalog.voices.find(
        (v) => v.id === (input.voices.find((r) => r?.speakerId === 'narrator')?.voiceId ?? source.settings.voiceId),
      )
    : undefined;
  const choices = new Map<string, { voiceId: string; instructions?: string }>();
  for (const row of input.voices) {
    if (!row || typeof row !== 'object') throw audiobookError(400, '인물 목소리를 확인해 주세요.');
    const speakerId = voiceText(row.speakerId, 256, true);
    const requestedVoiceId = voiceText(row.voiceId, 512, true);
    const voiceId = explicit?.includes(speakerId) ? (designPlaceholder?.id ?? requestedVoiceId) : requestedVoiceId;
    const instructions = row.instructions === undefined ? undefined : voiceText(row.instructions, 2000) || undefined;
    if (choices.has(speakerId) || !view.voices.some((v) => v.speakerId === speakerId))
      throw audiobookError(400, '이 작업에 있는 인물마다 목소리를 하나씩 골라 주세요.');
    const voice = catalog.voices.find((v) => v.id === voiceId);
    if (!voice?.model) throw audiobookError(409, '목소리 연결을 확인하고 다시 골라 주세요.');
    if (instructions && voice.instructionsSupported !== true)
      throw audiobookError(400, '선택한 목소리는 연기 지시를 지원하지 않아요.');
    choices.set(speakerId, { voiceId, instructions });
  }
  const selectedIds = [...new Set([...choices.values()].map((v) => v.voiceId))];
  const voices = selectedIds.map((id) => catalog.voices.find((v) => v.id === id)!);
  if ((mode === 'auto' || (mode === 'preserve' && view.hasActing)) && voices.some((v) => !v.autoActingSupported))
    throw audiobookError(400, '자동 연기를 끄거나 지원하는 목소리를 골라 주세요.');
  const actingAnalysis = mode === 'auto' && view.needsActing === true;
  let actingEngine: { id: string; revision: string } | undefined;
  let actingPaid = false;
  if (actingAnalysis) {
    const engineId = voiceText(input.acting?.engineId, 128, true);
    if (!engines) throw audiobookError(503, '연기 분석 연결을 확인해 주세요.');
    const engine = await engines.load(engineId);
    if (engine.purpose === 'casting') throw audiobookError(400, '화자 분석용 모델을 선택해 주세요.');
    actingEngine = { id: engineId, revision: speakerRevision(engine) };
    actingPaid = engine.paid;
  }
  if (input.applyToBook !== undefined && typeof input.applyToBook !== 'boolean')
    throw audiobookError(400, '앞으로 쓸 목소리 설정을 확인해 주세요.');
  const casting = normalizeCasting(
    explicit
      ? { ...input.casting, autoDesign: true, designMode: 'characters', maxDesignedVoices: explicit.length }
      : input.casting,
  );
  if (casting && (casting.designMode !== 'characters' || !casting.autoDesign || !engines || !library))
    throw audiobookError(400, '새 목소리 제작 설정을 확인해 주세요.');
  const selecting = casting?.engineId ? await engines!.loadCasting(casting.engineId) : undefined;
  const designer = casting
    ? (await library!.list()).designers.find((d) => d.id === casting.designProviderId)
    : undefined;
  const narratorVoiceId = choices.get('narrator')?.voiceId ?? source.settings.voiceId;
  const narratorModel = catalog.voices.find((v) => v.id === narratorVoiceId);
  const designVoice = casting ? catalog.voices.find((v) => v.providerId === casting.designProviderId) : undefined;
  if (
    casting &&
    (!designer ||
      !designVoice?.model ||
      !isGeminiVoiceDesignModel(casting.designModelId) ||
      !isGeminiVoiceDesignModel(designer.modelId) ||
      !isGeminiVoiceDesignModel(designVoice.model.modelId) ||
      !isGeminiVoiceDesignModel(narratorModel?.model?.modelId) ||
      narratorModel?.providerId !== casting.designProviderId)
  )
    throw audiobookError(400, '목소리 제작을 지원하는 Gemini 3.8 Flash TTS 연결을 골라 주세요.');
  const pinned = casting
    ? (
        await pool.query(
          'select speaker_id from speaker_voice_bindings where user_id=$1 and book_id=$2 and analysis_key=$3 and pinned',
          [owner, bookId, source.analysis_key],
        )
      ).rows.map((r) => r.speaker_id as string)
    : [];
  const recastSpeakers = explicit
    ? [...explicit].sort()
    : casting
      ? view.voices
          .filter(
            (v) =>
              v.speakerId !== 'narrator' &&
              !pinned.includes(v.speakerId) &&
              choices.get(v.speakerId)!.voiceId === v.voiceId,
          )
          .map((v) => v.speakerId)
      : [];
  if (casting && !recastSpeakers.length)
    throw audiobookError(400, '새 목소리를 만들 인물이 없어요. 직접 지정한 목소리는 유지해요.');
  const resolvedCasting = casting
    ? { ...casting, engineRevision: castingRevision(selecting!), designModel: designVoice!.model }
    : undefined;
  const models = Object.fromEntries(voices.map((v) => [v.id, v.model!]));
  const contextIds = source.chapter_ids.slice(0, source.next_chapter);
  const chapterIds = source.settings.chapterIds.filter((chapterId) => captured.some((i) => i.chapter_id === chapterId));
  if (captured.some((i) => !chapterIds.includes(i.chapter_id) || !contextIds.includes(i.chapter_id)))
    throw audiobookError(409, '분석이 완료된 회차의 음성을 골라 주세요.');
  const items: AudiobookPlan['items'] = [];
  let characters = 0,
    bytes = 0,
    changed = actingAnalysis || recastSpeakers.length > 0;
  for (const chapterId of chapterIds) {
    const loaded = await loadSpeakerChapter(pool, owner, bookId, chapterId, contextIds.indexOf(chapterId) + 1);
    const paragraphs = new Map(loaded.paragraphs.map((p) => [p.id, p]));
    for (const old of captured.filter((i) => i.chapter_id === chapterId)) {
      const choice = choices.get(old.request.cast.speakerId)!;
      const request: CastRequest = {
        ...old.request,
        voiceId: choice.voiceId,
        cast: { ...old.request.cast, model: models[choice.voiceId] },
      };
      if (choice.instructions) request.cast.instructions = choice.instructions;
      else delete request.cast.instructions;
      if (mode === 'off') delete request.cast.performance;
      const paragraph = paragraphs.get(request.paragraphId);
      if (!paragraph) throw audiobookError(409, '본문이 변경됐어요. 원래 음성의 본문을 확인해 주세요.');
      const playable = castPlayable(paragraph, request, source.settings.rules);
      changed ||= structuredIntegrityHash(request) !== structuredIntegrityHash(old.request);
      characters += [...playable.text].length;
      bytes += Buffer.byteLength(JSON.stringify(request));
      if (characters > 20_000_000 || bytes > 32 * 1024 * 1024)
        throw audiobookError(413, '다시 만들 음성의 범위가 너무 커요.');
      items.push({
        chapterId,
        chapterTitle: old.chapter_title,
        request,
        playable,
        paragraphIndex: paragraph.index - 1,
        nextParagraphIndex: paragraph.index,
      });
    }
  }
  if (!changed) throw audiobookError(400, '바꿀 목소리나 연기 지시를 먼저 선택해 주세요.');
  const fingerprint = structuredIntegrityHash({
    version: 'speaker-revoice-1',
    owner,
    bookId,
    sourceId: id,
    revision: source.content_revision,
    ...(actingEngine ? { actingEngine } : {}),
    ...(resolvedCasting ? { casting: resolvedCasting, recastSpeakers } : {}),
    ...(explicit ? { designSpeakerIds: [...explicit].sort() } : {}),
    applyToBook: input.applyToBook === true,
    items: items.map((i) => ({ chapterId: i.chapterId, request: i.request })),
  });
  const narrator = choices.get('narrator')?.voiceId ?? source.settings.voiceId;
  const changedSpeakers = view.voices.filter(
    (v) =>
      v.speakerId !== 'narrator' &&
      (recastSpeakers.includes(v.speakerId) || choices.get(v.speakerId)!.voiceId !== v.voiceId),
  );
  const bookVoiceVersions = input.applyToBook
    ? await bookBindingVersions(
        pool,
        owner,
        bookId,
        source.analysis_key,
        changedSpeakers.map((v) => v.speakerId),
      )
    : undefined;
  const bookVoiceUpdates = input.applyToBook
    ? changedSpeakers
        .filter((v) => !recastSpeakers.includes(v.speakerId))
        .map((v) => ({
          speakerId: v.speakerId,
          name: v.name,
          voiceId: choices.get(v.speakerId)!.voiceId,
          model: models[choices.get(v.speakerId)!.voiceId],
        }))
    : undefined;
  return {
    bookId,
    title: source.title,
    revision: source.content_revision,
    planningComplete: !actingAnalysis && !recastSpeakers.length,
    revoiceSource: { id, itemCount: captured.length, nextChapter: source.next_chapter },
    bookVoiceUpdates,
    speakerRun: {
      analysisKey: source.analysis_key,
      chapterIds: contextIds,
      nextChapter: contextIds.length,
      ledger: source.ledger,
      assignments: Object.fromEntries(
        [...choices].filter(([id]) => id !== 'narrator').map(([id, v]) => [id, v.voiceId]),
      ),
    },
    settings: {
      ...source.settings,
      chapterIds,
      voiceId: narrator,
      cast: {
        ...source.settings.cast!,
        voiceEvidenceVersion: 2,
        autoActing: mode === 'auto',
        actingEngine,
        revoiceFrom: id,
        casting: resolvedCasting,
        recastSpeakers,
        designSpeakerIds: explicit ? [...explicit].sort() : undefined,
        applyToBook: input.applyToBook === true,
        bookVoiceVersions,
        models,
        characterVoiceIds: selectedIds,
      },
    },
    items,
    estimate: {
      fingerprint,
      chapterCount: chapterIds.length,
      itemCount: items.length,
      characters,
      paid: actingPaid || !!selecting?.paid || !!designer?.paid || voices.some((v) => v.paid),
      ...(resolvedCasting
        ? {
            recastCharacters: recastSpeakers.length,
            selectionModelLabel: selecting!.name,
            maxDesignedVoices: resolvedCasting.maxDesignedVoices,
          }
        : {}),
      ...(actingAnalysis ? { actingAnalysis: true } : {}),
      voiceLabel: '화자별 목소리',
      providerName: [...new Set(voices.map((v) => v.providerName || v.providerId || 'TTS'))].join(' · '),
      firstChapterTitle: items[0].chapterTitle,
      lastChapterTitle: items[items.length - 1].chapterTitle,
    },
  };
}
