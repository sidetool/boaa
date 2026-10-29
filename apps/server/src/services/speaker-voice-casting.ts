import { createHash } from 'node:crypto';
import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSVoices, PlainTTSModel } from '../../../../src/providers/plain-tts';
import type { BookVoiceAssignment } from '../../../../src/providers/voice-library';
import type { SpeakerEngineResult, SpeakerChapter } from '../../../../src/providers/speaker-engine-protocol';
import type { SpeakerEngineStore } from '../providers/speaker-engine-store.js';
import { VoiceLibraryStore } from './voice-library-store.js';
import { audiobookError } from './audiobook-plan.js';
import {
  parseVoiceDecisions,
  selectionPrompt,
  stableVoice,
  VOICE_SELECTION_INSTRUCTION,
  VOICE_SELECTION_SCHEMA,
  type VoiceCandidate,
  type VoiceDecision,
} from './speaker-voice-selection.js';

export interface CastingRun {
  id: string;
  book_id: string;
  analysis_key: string;
  content_revision: string | null;
  settings: AudiobookInput;
  assignments: Record<string, string>;
}
type Binding = {
  speaker_id: string;
  name: string;
  voice_id: string;
  model: PlainTTSModel;
  metadata: Omit<VoiceDecision, 'speakerId' | 'voiceId'>;
  pinned: boolean;
};
export class SpeakerVoiceCasting {
  constructor(
    private pool: pg.Pool,
    private owner: string,
    readonly library: VoiceLibraryStore,
    private engines: SpeakerEngineStore,
    private catalog: () => Promise<PlainTTSVoices>,
  ) {}
  private async authority(run: CastingRun, db: Pick<pg.Pool, 'query'>, lock = false) {
    if (
      !(
        await db.query(
          `select a.id from saved_audiobooks a join library_books b on b.id=a.book_id where a.id=$1 and a.user_id=$2 and b.user_id=$2 and b.deleted_at is null and a.status<>'deleting' and b.active_content_revision_id is not distinct from $3::text
      and not exists(select 1 from self_host_accounts where user_id=$2 and (role<>'admin' or status<>'active')) ${lock ? 'for share of a,b' : ''}`,
          [run.id, this.owner, run.content_revision],
        )
      ).rowCount
    )
      throw audiobookError(409, '작품이나 계정이 변경돼 목소리 배정을 멈췄어요.');
  }
  private async bindings(run: CastingRun, db: Pick<pg.Pool, 'query'> = this.pool): Promise<Binding[]> {
    return (
      await db.query('select * from speaker_voice_bindings where user_id=$1 and book_id=$2 and analysis_key=$3', [
        this.owner,
        run.book_id,
        run.analysis_key,
      ])
    ).rows;
  }
  private allowedModel(run: CastingRun, model: PlainTTSModel) {
    const config = run.settings.cast!;
    return (
      Object.values(config.models).some((m) => structuredIntegrityHash(m) === structuredIntegrityHash(model)) ||
      (config.casting?.autoDesign === true &&
        structuredIntegrityHash(config.casting.designModel) === structuredIntegrityHash(model))
    );
  }
  private async saveDecision(run: CastingRun, key: string, response: string) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.library.authority(c, true);
      await this.authority(run, c, true);
      const options = run.settings.cast!.casting!;
      await this.engines.loadCasting(options.engineId!, options.engineRevision, c);
      await c.query(
        'update speaker_voice_decisions set response=$3,dispatching=false where audiobook_id=$1 and decision_key=$2',
        [run.id, key, response],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async list(run: CastingRun): Promise<BookVoiceAssignment[]> {
    await this.authority(run, this.pool);
    return (await this.bindings(run)).map((b) => ({
      speakerId: b.speaker_id,
      name: b.name,
      voiceId: b.voice_id,
      alias: b.metadata.alias,
      timbre: b.metadata.timbre,
      description: b.metadata.description,
      importance: b.metadata.importance,
      pinned: b.pinned,
    }));
  }
  async assign(run: CastingRun, speakerId: string, voiceId: string) {
    const voice = (await this.catalog()).voices.find((v) => v.id === voiceId);
    if (!voice?.model || !run.settings.cast!.models[voiceId])
      throw audiobookError(400, '이 작업에서 확인한 목소리 중에 골라 주세요.');
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.library.authority(c, true);
      await this.authority(run, c, true);
      await this.library.source(voice.model.providerId, run.settings.cast!.models[voiceId]);
      const job = (await c.query('select status from saved_audiobooks where id=$1 for update', [run.id])).rows[0];
      if (!['paused', 'failed', 'completed'].includes(job?.status))
        throw audiobookError(409, '만들기를 잠시 멈춘 뒤 인물 목소리를 바꿔 주세요.');
      const row = (
        await c.query(
          'update speaker_voice_bindings set voice_id=$4,model=$5,pinned=true,updated_at=now() where user_id=$1 and book_id=$2 and analysis_key=$3 and speaker_id=$6 returning *',
          [this.owner, run.book_id, run.analysis_key, voiceId, voice.model, speakerId],
        )
      ).rows[0];
      if (!row) throw audiobookError(404, '배정된 인물을 찾을 수 없어요.');
      // Existing item requests remain immutable. This choice applies to the next planned chapter.
      await c.query(
        'update speaker_generation_runs set assignments=jsonb_set(assignments,array[$2]::text[],to_jsonb($3::text)) where audiobook_id=$1',
        [run.id, speakerId, voiceId],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async select(
    run: CastingRun,
    chapter: SpeakerChapter,
    result: Extract<SpeakerEngineResult, { kind: 'complete' }>,
    signal: AbortSignal,
    fallbackAssignments?: Record<string, string>,
  ): Promise<{ assignments: Record<string, string>; models: Record<string, PlainTTSModel> } | undefined> {
    const config = run.settings.cast!,
      options = config.casting;
    const catalog = await this.catalog(),
      library = (await this.library.list()).voices;
    const candidates: VoiceCandidate[] = config.characterVoiceIds.flatMap((voiceId) => {
      const voice = catalog.voices.find((v) => v.id === voiceId),
        saved = library.find((v) => v.voiceId === voiceId);
      if (!voice || saved?.enabled === false) return [];
      if (structuredIntegrityHash(voice.model) !== structuredIntegrityHash(config.models[voiceId]))
        throw audiobookError(409, '배정할 목소리의 모델이 바뀌었어요.');
      return [
        {
          voiceId,
          alias: saved?.alias ?? voice.label,
          timbre: saved?.timbre ?? '',
          description: saved?.description || voice.description || '',
          language: saved?.language ?? voice.lang ?? '',
        },
      ];
    });
    const isolated = !!config.revoiceFrom;
    const bindings = isolated ? [] : await this.bindings(run),
      assignments = { ...run.assignments },
      models = { ...config.models };
    const audible = new Set(result.labels.filter((l) => !l.reviewRequired).map((l) => l.speakerId));
    const identities = result.identities.filter((i) => !i.reviewRequired && audible.has(i.id));
    for (const i of identities) {
      const old = bindings.find((b) => b.speaker_id === i.id);
      if (Object.hasOwn(assignments, i.id) && !old?.pinned) continue;
      if (old?.pinned && !this.allowedModel(run, old.model))
        throw audiobookError(
          409,
          '직접 지정한 목소리가 이 작업에서 확인한 TTS 모델과 달라요. 목소리 설정을 확인해 주세요.',
        );
      const replacePreset =
        options?.designMode === 'characters' &&
        !old?.pinned &&
        library.find((v) => v.voiceId === old?.voice_id)?.origin !== 'designed';
      if (old && !replacePreset && this.allowedModel(run, old.model)) {
        const voice = catalog.voices.find((v) => v.id === old.voice_id);
        if (!voice || structuredIntegrityHash(voice.model) !== structuredIntegrityHash(old.model))
          throw audiobookError(409, '이 작품에 배정한 목소리가 없거나 모델이 바뀌었어요. 기존 배정을 확인해 주세요.');
        assignments[i.id] = old.voice_id;
        models[old.voice_id] = old.model;
      }
    }
    const missing = identities.filter((i) => !Object.hasOwn(assignments, i.id));
    if (!missing.length) return { assignments, models };
    if (!candidates.length) throw audiobookError(409, '자동 배정에 쓸 목소리를 켜 주세요.');
    const batch = missing.slice(0, 8);
    const requiredDesignIds = batch.filter((i) => config.designSpeakerIds?.includes(i.id)).map((i) => i.id);
    const prompt = selectionPrompt(
      chapter,
      result.labels,
      batch,
      candidates,
      options?.autoDesign === true,
      options?.designMode,
      requiredDesignIds,
      config.voiceEvidenceVersion === 2,
    );
    const key = structuredIntegrityHash({
      chapter: chapter.id,
      ids: batch.map((i) => i.id),
      prompt,
      engine: options?.engineId,
      revision: options?.engineRevision,
    });
    let decisions: VoiceDecision[];
    if (options?.engineId) {
      const engine = await this.engines.loadCasting(options.engineId, options.engineRevision);
      await this.pool.query(
        'insert into speaker_voice_decisions(audiobook_id,decision_key) values($1,$2) on conflict do nothing',
        [run.id, key],
      );
      const old = (
        await this.pool.query('select * from speaker_voice_decisions where audiobook_id=$1 and decision_key=$2', [
          run.id,
          key,
        ])
      ).rows[0];
      let response = old.response as string | null;
      if (!response) {
        if (old.dispatching) throw audiobookError(409, '목소리 선정 요청이 중단됐어요. 이어 만들기를 눌러 주세요.');
        signal.throwIfAborted();
        await this.authority(run, this.pool);
        const claimed = await this.pool.query(
          'update speaker_voice_decisions set dispatching=true where audiobook_id=$1 and decision_key=$2 and not dispatching and response is null returning decision_key',
          [run.id, key],
        );
        if (!claimed.rowCount) throw audiobookError(409, '목소리 선정이 이미 진행 중이에요.');
        try {
          response = await this.engines.transport.generateJson(
            engine,
            { prompt, schema: VOICE_SELECTION_SCHEMA },
            AbortSignal.any([signal, AbortSignal.timeout(90000)]),
            VOICE_SELECTION_INSTRUCTION,
          );
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 429) {
            await this.pool.query(
              'update speaker_voice_decisions set dispatching=false where audiobook_id=$1 and decision_key=$2',
              [run.id, key],
            );
            Object.assign(e as object, {
              requestStage: 'voice_selection',
              analysisRetryLimit: engine.rateLimitRetries,
            });
          }
          throw e;
        }
        if (Buffer.byteLength(response) > 262144) throw audiobookError(502, '목소리 선정 응답이 너무 커요.');
        await this.saveDecision(run, key, response);
      }
      try {
        decisions = parseVoiceDecisions(
          response,
          batch.map((i) => i.id),
          candidates,
          options.autoDesign,
          options.designMode,
          requiredDesignIds,
        );
      } catch (e) {
        await this.pool.query(
          'update speaker_voice_decisions set rejected=true where audiobook_id=$1 and decision_key=$2',
          [run.id, key],
        );
        throw e;
      }
    } else
      decisions = batch.map((i) => ({
        speakerId: i.id,
        voiceId: stableVoice(i.id, candidates),
        importance: 'extra',
        alias: i.name,
        timbre: '',
        description: '',
        designPrompt: '',
      }));
    let designed = Number(
      (
        await this.pool.query(
          "select count(*) n from tts_voice_designs where user_id=$1 and request_id like $2 and status='ready'",
          [this.owner, `cast_${run.id.replaceAll('-', '')}_%`],
        )
      ).rows[0].n,
    );
    for (const d of decisions) {
      signal.throwIfAborted();
      const requestId = `cast_${run.id.replaceAll('-', '')}_${createHash('sha256').update(d.speakerId).digest('hex')}`;
      const created = (
        await this.pool.query(
          "select v.* from tts_voice_designs d join tts_voice_library v on v.id=d.voice_id and v.user_id=d.user_id where d.user_id=$1 and d.request_id=$2 and d.status='ready'",
          [this.owner, requestId],
        )
      ).rows[0];
      let madeVoice = false;
      if (created) {
        madeVoice = true;
        d.voiceId = created.voice_id;
        models[created.voice_id] = created.model;
      } else if (d.designPrompt && options?.autoDesign && designed < options.maxDesignedVoices) {
        await this.library.source(options.designProviderId!, options.designModel);
        const voice = await this.library.design(
          {
            requestId,
            providerId: options.designProviderId!,
            modelId: options.designModelId!,
            alias: d.alias || batch.find((i) => i.id === d.speakerId)!.name,
            prompt: d.designPrompt,
            language: config.language ?? 'ko',
            confirmPaid: true,
          },
          AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        );
        d.voiceId = voice.voiceId;
        models[voice.voiceId] = voice.model;
        designed++;
        madeVoice = true;
      }
      if (requiredDesignIds.includes(d.speakerId) && !madeVoice)
        throw audiobookError(409, '선택한 인물의 새 목소리를 만들지 못했어요. 설정을 확인하고 다시 시도해 주세요.');
      if (isolated && !madeVoice && fallbackAssignments?.[d.speakerId]) d.voiceId = fallbackAssignments[d.speakerId];
      assignments[d.speakerId] = d.voiceId;
    }
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.library.authority(c, true);
      await this.authority(run, c, true);
      if (options?.engineId) await this.engines.loadCasting(options.engineId, options.engineRevision, c);
      for (const d of decisions) {
        const { speakerId, voiceId, ...metadata } = d;
        const model = models[voiceId];
        if (!model) throw audiobookError(409, '선정한 목소리의 모델이 없어요.');
        await this.library.source(model.providerId, model);
        if (!isolated)
          await c.query(
            `insert into speaker_voice_bindings(user_id,book_id,analysis_key,speaker_id,name,voice_id,model,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)
          on conflict(user_id,book_id,analysis_key,speaker_id) do update set voice_id=excluded.voice_id,model=excluded.model,metadata=excluded.metadata,updated_at=now() where not speaker_voice_bindings.pinned`,
            [
              this.owner,
              run.book_id,
              run.analysis_key,
              speakerId,
              batch.find((i) => i.id === speakerId)!.name,
              voiceId,
              model,
              metadata,
            ],
          );
      }
      for (const binding of isolated ? [] : await this.bindings(run, c))
        if (binding.pinned && Object.hasOwn(assignments, binding.speaker_id)) {
          if (!this.allowedModel(run, binding.model))
            throw audiobookError(409, '직접 지정한 목소리가 이 작업의 TTS 모델과 달라요.');
          await this.library.source(binding.model.providerId, binding.model);
          assignments[binding.speaker_id] = binding.voice_id;
          models[binding.voice_id] = binding.model;
        }
      if (!isolated) {
        // Keep progress for this job even when another batch or chapter acceptance is still pending.
        await c.query('update speaker_generation_runs set assignments=$2 where audiobook_id=$1', [run.id, assignments]);
        await c.query(
          "update saved_audiobooks set settings=jsonb_set(settings,'{cast,models}',$2::jsonb) where id=$1",
          [run.id, JSON.stringify(models)],
        );
      }
      if (!isolated)
        await c.query('delete from speaker_voice_decisions where audiobook_id=$1 and decision_key=$2', [run.id, key]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    return missing.length > batch.length ? undefined : { assignments, models };
  }
}
