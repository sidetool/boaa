import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import type {
  SpeakerEngineInput,
  SpeakerEngine,
  SpeakerEngineDiscovery,
} from '../../../../src/providers/speaker-engine';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  loadProviderSecretMasterKey,
} from './server-provider-secrets.js';
import { connectionError } from './tts-connection-config.js';
import { normalizeSpeakerEngine, speakerRevision, castingRevision } from './speaker-engine-config.js';
import { SpeakerEngineTransport } from './speaker-engine-transport.js';
type Row = { id: string; ciphertext: string; iv: string; auth_tag: string; key_version: string };
export class SpeakerEngineStore {
  constructor(
    private pool: pg.Pool,
    private config: ServerConfig,
    private env: NodeJS.ProcessEnv = process.env,
    readonly transport = new SpeakerEngineTransport({}, env.SPEAKER_ENGINE_TOKEN),
  ) {}
  private aad(id: string) {
    return `${this.config.defaultUserId}:speaker-engine:${id}`;
  }
  private decode(row: Row) {
    return normalizeSpeakerEngine(
      JSON.parse(decryptProviderSecret(loadProviderSecretMasterKey(this.config, this.env), row, this.aad(row.id))),
    );
  }
  private view(row: Row): SpeakerEngine {
    const { apiKey, engineToken, serviceAccountJson, ...v } = this.decode(row);
    return {
      ...v,
      id: row.id,
      hasApiKey: !!apiKey,
      hasEngineToken: !!engineToken,
      ...(v.protocol === 'vertex' ? { hasServiceAccount: !!serviceAccountJson } : {}),
      revision: speakerRevision(v),
    };
  }
  private async row(id: string, db: Pick<pg.Pool, 'query'> = this.pool): Promise<Row> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw connectionError('분석 연결을 찾을 수 없어요.', 404);
    const r = (
      await db.query<Row>('select * from speaker_engines where id=$1 and user_id=$2', [id, this.config.defaultUserId])
    ).rows[0];
    if (!r) throw connectionError('분석 연결을 찾을 수 없어요.', 404);
    return r;
  }
  async list() {
    return (
      await this.pool.query<Row>('select * from speaker_engines where user_id=$1 order by created_at,id', [
        this.config.defaultUserId,
      ])
    ).rows.map((r) => this.view(r));
  }
  async load(id: string, revision?: string, db?: Pick<pg.Pool, 'query'>) {
    if (db)
      await db.query('select id from speaker_engines where id=$1 and user_id=$2 for share', [
        id,
        this.config.defaultUserId,
      ]);
    const v = this.decode(await this.row(id, db));
    if (!v.enabled || (revision && speakerRevision(v) !== revision))
      throw connectionError('이 작업의 분석 모델 연결이 바뀌었어요. 기존 결과는 보관돼 있어요.', 409);
    return v;
  }
  async loadCasting(id: string, revision?: string, db?: Pick<pg.Pool, 'query'>) {
    const v = await this.load(id, undefined, db);
    if (v.purpose !== 'casting') throw connectionError('목소리 선정용 모델 연결을 골라 주세요.', 400);
    if (revision && castingRevision(v) !== revision)
      throw connectionError('목소리 선정 모델이 바뀌었어요. 기존 배정은 보관돼 있어요.', 409);
    return v;
  }
  private merge(v: SpeakerEngineInput, old: SpeakerEngineInput) {
    if (v.protocol === 'vertex' && old.protocol === 'vertex' && v.serviceAccountJson === undefined)
      v = { ...v, serviceAccountJson: old.serviceAccountJson };
    for (const [key, address] of [
      ['apiKey', 'url'],
      ['engineToken', 'engineUrl'],
    ] as const) {
      if ((key !== 'apiKey' || v.protocol !== 'vertex') && v[key] === undefined && old[key]) {
        if (new URL(v[address]).origin !== new URL(old[address]).origin)
          throw connectionError('서버 주소가 바뀌었어요. 해당 키를 다시 입력하거나 지워 주세요.');
        v = { ...v, [key]: old[key] };
      }
    }
    return v;
  }
  async save(input: unknown, id?: string) {
    let v = normalizeSpeakerEngine(input);
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('select id from users where id=$1 for update', [this.config.defaultUserId]);
      if (id) v = this.merge(v, this.decode(await this.row(id, c)));
      else if (
        Number(
          (await c.query('select count(*) n from speaker_engines where user_id=$1', [this.config.defaultUserId]))
            .rows[0].n,
        ) >= 16
      )
        throw connectionError('분석 연결은 최대 16개까지 추가할 수 있어요.', 409);
      const key = id ?? randomUUID();
      const e = encryptProviderSecret(
        loadProviderSecretMasterKey(this.config, this.env),
        JSON.stringify(v),
        this.aad(key),
      );
      const r = (
        await c.query<Row>(
          `insert into speaker_engines(id,user_id,ciphertext,iv,auth_tag,key_version) values($1,$2,$3,$4,$5,'local-aes-256-gcm-v1')
      on conflict(id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=now() where speaker_engines.user_id=excluded.user_id returning *`,
          [key, this.config.defaultUserId, e.ciphertext, e.iv, e.authTag],
        )
      ).rows[0];
      await c.query('commit');
      return this.view(r);
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  async remove(id: string) {
    await this.row(id);
    await this.pool.query('delete from speaker_engines where id=$1 and user_id=$2', [id, this.config.defaultUserId]);
  }
  async probe(input: unknown, signal: AbortSignal, id?: string): Promise<SpeakerEngineDiscovery> {
    let v = normalizeSpeakerEngine(input, true);
    if (id) v = this.merge(v, this.decode(await this.row(id)));
    const capabilities =
      v.purpose === 'casting' ? { engineVersion: 'voice-selection-v1' } : await this.transport.capabilities(v, signal);
    return { engineVersion: capabilities.engineVersion, models: await this.transport.models(v, signal) };
  }
}
