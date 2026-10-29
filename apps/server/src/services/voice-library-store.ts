import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { LibraryVoice, VoiceLibraryInput, VoiceDesignInput } from '../../../../src/providers/voice-library';
import type { PlainTTSVoices } from '../../../../src/providers/plain-tts';
import type { PlainTTSSource } from '../providers/plain-tts-sources.js';
import { audiobookError } from './audiobook-plan.js';

export const sourceVoiceKey = (s: PlainTTSSource, id: string) =>
  s.legacyIds ? id : `${s.id}:${encodeURIComponent(id)}`;
export const voiceSourceModel = (s: PlainTTSSource) => ({
  providerId: s.id,
  modelId: s.modelId,
  revision: s.synthesisRevision ?? s.revision,
});
export function voiceText(value: unknown, max: number, required = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    Array.from(value).some((c) => {
      const n = c.charCodeAt(0);
      return (n < 32 && n !== 9 && n !== 10) || n === 127;
    }) ||
    (required && !value.trim())
  )
    throw audiobookError(400, '목소리 이름과 설명을 확인해 주세요.');
  return value.trim();
}
export function voiceMetadata(v: VoiceLibraryInput) {
  if (!v || typeof v.enabled !== 'boolean') throw audiobookError(400, '목소리 설정을 확인해 주세요.');
  return {
    alias: voiceText(v.alias, 80, true),
    timbre: voiceText(v.timbre, 200),
    description: voiceText(v.description, 2000),
    language: voiceText(v.language, 40),
    enabled: v.enabled,
  };
}
type Row = {
  id: string;
  voice_id: string;
  provider_id: string;
  provider_voice_id: string;
  model: LibraryVoice['model'];
  metadata: Omit<VoiceLibraryInput, 'voiceId'>;
  origin: LibraryVoice['origin'];
  design_prompt?: string;
  sample?: Buffer;
  has_sample?: boolean;
  sample_type?: string;
  created_at: Date;
};
const view = (r: Row, available = true): LibraryVoice => ({
  ...r.metadata,
  id: r.id,
  voiceId: r.voice_id,
  providerId: r.provider_id,
  providerVoiceId: r.provider_voice_id,
  model: r.model,
  origin: r.origin,
  designPrompt: r.design_prompt ?? undefined,
  sampleAvailable: !!r.sample || r.has_sample === true,
  available,
  createdAt: r.created_at.toISOString(),
});

export class VoiceLibraryStore {
  constructor(
    readonly pool: pg.Pool,
    readonly owner: string,
    private sources: () => Promise<PlainTTSSource[]>,
    private catalog: () => Promise<PlainTTSVoices>,
  ) {}
  async authority(db: Pick<pg.Pool, 'query'> = this.pool, lock = false) {
    if (lock) await db.query('select user_id from self_host_accounts where user_id=$1 for share', [this.owner]);
    if (
      !(
        await db.query(
          `select id from users where id=$1 and not exists(select 1 from self_host_accounts where user_id=$1 and (role<>'admin' or status<>'active')) ${lock ? 'for update' : ''}`,
          [this.owner],
        )
      ).rowCount
    )
      throw audiobookError(403, '목소리를 관리할 수 없는 계정이에요.');
  }
  async rows(db: Pick<pg.Pool, 'query'> = this.pool): Promise<Row[]> {
    return (
      await db.query(
        'select id,voice_id,provider_id,provider_voice_id,model,metadata,origin,design_prompt,(sample is not null) has_sample,created_at from tts_voice_library where user_id=$1 order by created_at,id limit 256',
        [this.owner],
      )
    ).rows;
  }
  async source(id: string, expected?: LibraryVoice['model']) {
    const s = (await this.sources()).find((s) => s.id === id);
    if (!s || (expected && structuredIntegrityHash(voiceSourceModel(s)) !== structuredIntegrityHash(expected)))
      throw audiobookError(409, '목소리의 TTS 연결이나 모델이 바뀌었어요. 저장된 음성은 유지돼요.');
    return s;
  }
  async list() {
    await this.authority();
    const sources = await this.sources();
    const designers = [];
    for (const s of sources) {
      const adapter = await s.createProvider();
      if (adapter.designVoice && adapter.supportsVoiceDesign !== false)
        designers.push({ id: s.id, name: s.name, modelId: s.modelId ?? '', paid: s.paid });
    }
    return {
      voices: (await this.rows()).map((r) =>
        view(
          r,
          sources.some(
            (s) =>
              s.id === r.provider_id &&
              structuredIntegrityHash(voiceSourceModel(s)) === structuredIntegrityHash(r.model),
          ),
        ),
      ),
      designers,
    };
  }
  async save(input: VoiceLibraryInput, id?: string): Promise<LibraryVoice> {
    if (id !== undefined) this.validId(id);
    const metadata = voiceMetadata(input);
    const voiceId = voiceText(input.voiceId, 512, true);
    const voice = (await this.catalog()).voices.find((v) => v.id === voiceId);
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.authority(c, true);
      if (
        !id &&
        (await c.query('select 1 from tts_voice_library where user_id=$1 and voice_id=$2', [this.owner, voiceId]))
          .rowCount
      )
        throw audiobookError(409, '이미 보관함에 있는 목소리예요. 수정에서 설명을 바꿔 주세요.');
      const old = id
        ? ((await c.query('select * from tts_voice_library where id=$1 and user_id=$2', [id, this.owner])).rows[0] as
            Row | undefined)
        : undefined;
      if (id && !old) throw audiobookError(404, '목소리를 찾을 수 없어요.');
      if (old && old.voice_id !== voiceId)
        throw audiobookError(400, '음성 ID는 바꾸지 않고 새 목소리로 추가해 주세요.');
      if (!old && (!voice?.model || !voice.providerId))
        throw audiobookError(409, '목소리 목록에서 추가할 목소리를 골라 주세요.');
      const reserved = Number(
        (
          await c.query("select count(*) n from tts_voice_designs where user_id=$1 and status='dispatching'", [
            this.owner,
          ])
        ).rows[0].n,
      );
      if (!old && (await this.rows(c)).length + reserved >= 256)
        throw audiobookError(409, '보관함은 최대 256개까지 저장할 수 있어요.');
      let r: Row;
      if (old)
        r = (
          await c.query(
            'update tts_voice_library set metadata=$3,updated_at=now() where id=$1 and user_id=$2 returning *',
            [id, this.owner, metadata],
          )
        ).rows[0];
      else {
        const s = await this.source(voice!.providerId!, voice!.model);
        const providerVoiceId = s.legacyIds ? voiceId : decodeURIComponent(voiceId.slice(s.id.length + 1));
        r = (
          await c.query(
            `insert into tts_voice_library(id,user_id,voice_id,provider_id,provider_voice_id,model,metadata,origin) values($1,$2,$3,$4,$5,$6,$7,'catalog') returning *`,
            [randomUUID(), this.owner, voiceId, s.id, providerVoiceId, voice!.model, metadata],
          )
        ).rows[0];
      }
      await c.query('commit');
      return view(r);
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async remove(id: string) {
    this.validId(id);
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.authority(c, true);
      const r = (await c.query('select * from tts_voice_library where user_id=$1 and id=$2', [this.owner, id]))
        .rows[0] as Row | undefined;
      if (!r) throw audiobookError(404, '목소리를 찾을 수 없어요.');
      if (
        (
          await c.query('select 1 from speaker_voice_bindings where user_id=$1 and voice_id=$2 limit 1', [
            this.owner,
            r.voice_id,
          ])
        ).rowCount
      )
        throw audiobookError(409, '작품에 배정된 목소리예요. 자동 배정에서 제외하려면 사용 스위치를 꺼 주세요.');
      await c.query('delete from tts_voice_library where user_id=$1 and id=$2', [this.owner, id]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async sample(id: string) {
    this.validId(id);
    await this.authority();
    const r = (await this.pool.query('select * from tts_voice_library where user_id=$1 and id=$2', [this.owner, id]))
      .rows[0] as Row | undefined;
    if (!r) throw audiobookError(404, '목소리를 찾을 수 없어요.');
    return {
      voice: view(r),
      audio: r.sample && r.sample_type ? { data: r.sample, contentType: r.sample_type } : undefined,
    };
  }
  async design(input: VoiceDesignInput, signal: AbortSignal): Promise<LibraryVoice> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw audiobookError(400, '목소리 만들기 설정을 확인해 주세요.');
    const alias = voiceText(input.alias, 80, true),
      prompt = voiceText(input.prompt, 2000, true),
      language = voiceText(input.language, 40),
      modelId = voiceText(input.modelId, 200, true);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,160}$/.test(input.requestId.replaceAll('-', '_')))
      throw audiobookError(400, '목소리 만들기 요청을 확인해 주세요.');
    const s = await this.source(input.providerId),
      model = voiceSourceModel(s),
      adapter = await s.createProvider();
    if (!adapter.designVoice || adapter.supportsVoiceDesign === false)
      throw audiobookError(400, '이 TTS 연결은 설명으로 목소리 만들기를 지원하지 않아요.');
    if (s.paid && input.confirmPaid !== true) throw audiobookError(400, '목소리 만들기의 API 사용을 확인해 주세요.');
    const hash = structuredIntegrityHash({ alias, prompt, language, modelId, model });
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await this.authority(c, true);
      const old = (
        await c.query('select * from tts_voice_designs where user_id=$1 and request_id=$2', [
          this.owner,
          input.requestId,
        ])
      ).rows[0];
      if (old) {
        if (old.input_hash !== hash) throw audiobookError(409, '이미 보낸 요청의 내용이 달라졌어요.');
        if (old.status === 'ready') {
          const row = (
            await c.query('select * from tts_voice_library where user_id=$1 and id=$2', [this.owner, old.voice_id])
          ).rows[0];
          if (!row) throw audiobookError(409, '이 요청으로 만든 목소리는 이미 삭제됐어요.');
          await c.query('commit');
          return view(row);
        }
        if (old.status !== 'retry')
          throw audiobookError(
            409,
            '목소리 만들기 결과가 아직 확인되지 않았어요. 중복 생성을 막기 위해 다시 보내지 않았어요.',
          );
      }
      const quota = (
        await c.query(
          'select count(*) n,coalesce(sum(octet_length(sample)),0) bytes from tts_voice_library where user_id=$1',
          [this.owner],
        )
      ).rows[0];
      await c.query(
        "update tts_voice_designs set status='uncertain' where user_id=$1 and status='dispatching' and created_at<now()-interval '5 minutes'",
        [this.owner],
      );
      const reserved = Number(
        (
          await c.query("select count(*) n from tts_voice_designs where user_id=$1 and status='dispatching'", [
            this.owner,
          ])
        ).rows[0].n,
      );
      if (Number(quota.n) + reserved >= 256 || Number(quota.bytes) + (reserved + 1) * 4194304 > 64 * 1024 * 1024)
        throw audiobookError(413, '목소리 보관함이 가득 찼어요.');
      if (reserved >= 2) throw audiobookError(429, '다른 목소리를 만들고 있어요. 잠시 후 다시 시도해 주세요.');
      signal.throwIfAborted();
      await c.query(
        "insert into tts_voice_designs(user_id,request_id,input_hash,status) values($1,$2,$3,'dispatching') on conflict(user_id,request_id) do update set status='dispatching',created_at=now()",
        [this.owner, input.requestId, hash],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    let result;
    try {
      result = await adapter.designVoice({ alias, prompt, language, modelId, signal });
    } catch (e) {
      await this.pool.query('update tts_voice_designs set status=$3 where user_id=$1 and request_id=$2', [
        this.owner,
        input.requestId,
        (e as { statusCode?: number; status?: number }).statusCode === 429 || (e as { status?: number }).status === 429
          ? 'retry'
          : 'uncertain',
      ]);
      if (e && typeof e === 'object') Object.assign(e, { requestStage: 'voice_design' });
      throw e;
    }
    if (
      !/^voice_[A-Za-z0-9_-]{1,240}$/.test(result.id) ||
      (result.sample &&
        (result.sample.data.byteLength > 4194304 || !['audio/wav', 'audio/mpeg'].includes(result.sample.contentType)))
    )
      throw audiobookError(502, '만들어진 목소리의 응답 형식을 확인할 수 없어요.');
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      await this.authority(db, true);
      await this.source(s.id, model);
      const quota = (
        await db.query(
          'select count(*) n,coalesce(sum(octet_length(sample)),0) bytes from tts_voice_library where user_id=$1',
          [this.owner],
        )
      ).rows[0];
      if (Number(quota.n) >= 256 || Number(quota.bytes) + (result.sample?.data.byteLength ?? 0) > 64 * 1024 * 1024)
        throw audiobookError(413, '목소리 보관함이 가득 찼어요.');
      const row = (
        await db.query(
          `insert into tts_voice_library(id,user_id,voice_id,provider_id,provider_voice_id,model,metadata,origin,design_prompt,sample,sample_type)
        values($1,$2,$3,$4,$5,$6,$7,'designed',$8,$9,$10) returning *`,
          [
            randomUUID(),
            this.owner,
            sourceVoiceKey(s, result.id),
            s.id,
            result.id,
            model,
            { alias, timbre: '', description: prompt, language, enabled: true },
            prompt,
            result.sample ? Buffer.from(result.sample.data) : null,
            result.sample?.contentType ?? null,
          ],
        )
      ).rows[0];
      await db.query("update tts_voice_designs set status='ready',voice_id=$3 where user_id=$1 and request_id=$2", [
        this.owner,
        input.requestId,
        row.id,
      ]);
      await db.query('commit');
      return view(row);
    } catch (e) {
      await db.query('rollback');
      throw e;
    } finally {
      db.release();
    }
  }
  private validId(id: string) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
      throw audiobookError(400, '목소리 ID를 확인해 주세요.');
  }
}
