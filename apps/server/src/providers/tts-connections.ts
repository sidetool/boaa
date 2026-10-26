import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type {
  TTSConnection,
  TTSConnectionInput,
  TTSConnectionDiscovery,
  TTSConnectionVoice,
} from '../../../../src/providers/tts-connections';
import type { ServerConfig } from '../config.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  loadProviderSecretMasterKey,
} from './server-provider-secrets.js';
import { normalizeTTSConnection, connectionError, ttsConnectionModelRevision } from './tts-connection-config.js';
import { requestLocalEndpoint, type LocalEndpointEgressOptions } from './local-endpoint-egress-policy.js';
import { ConnectionTTSProvider } from './tts-connection-provider.js';
import type { PlainTTSSource } from './plain-tts-sources.js';

interface Row {
  id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: string;
}
const columns = 'id,ciphertext,iv,auth_tag,key_version';
const keyVersion = 'local-aes-256-gcm-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TTSConnectionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: ServerConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly network: LocalEndpointEgressOptions = {},
  ) {}
  private aad(id: string) {
    return `${this.config.defaultUserId}:tts-connection:${id}`;
  }
  private decode(row: Row): TTSConnectionInput {
    return normalizeTTSConnection(
      JSON.parse(decryptProviderSecret(loadProviderSecretMasterKey(this.config, this.env), row, this.aad(row.id))),
    );
  }
  private public(row: Row, value = this.decode(row)): TTSConnection {
    const { apiKey, ...visible } = value;
    return { ...visible, id: row.id, hasApiKey: !!apiKey, revision: structuredIntegrityHash(row.ciphertext) };
  }
  private async rows(): Promise<Row[]> {
    return (
      await this.pool.query<Row>(`select ${columns} from tts_connections where user_id=$1 order by created_at,id`, [
        this.config.defaultUserId,
      ])
    ).rows;
  }
  private async row(id: string, queryable: Pick<pg.Pool, 'query'> = this.pool): Promise<Row> {
    if (!uuid.test(id)) throw connectionError('연결을 찾을 수 없어요.', 404);
    const result = await queryable.query<Row>(`select ${columns} from tts_connections where id=$1 and user_id=$2`, [
      id,
      this.config.defaultUserId,
    ]);
    if (!result.rows[0]) throw connectionError('연결을 찾을 수 없어요.', 404);
    return result.rows[0];
  }
  async list(): Promise<TTSConnection[]> {
    return (await this.rows()).map((row) => this.public(row));
  }
  async save(input: unknown, id?: string): Promise<TTSConnection> {
    let value = normalizeTTSConnection(input);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Serialize additions and updates for this owner, including the bounded connection count.
      await client.query('select id from users where id=$1 for update', [this.config.defaultUserId]);
      if (id) {
        const row = await this.row(id, client);
        const previous = this.decode(row);
        if (value.apiKey === undefined && previous.apiKey) {
          if (new URL(value.url).origin !== new URL(previous.url).origin)
            throw connectionError('서버 주소가 바뀌었어요. 이 서버에서 쓸 API 키를 다시 입력하거나 지워 주세요.');
          value = { ...value, apiKey: previous.apiKey };
        }
      } else {
        const { rows } = await client.query<{ count: string }>(
          'select count(*) from tts_connections where user_id=$1',
          [this.config.defaultUserId],
        );
        if (Number(rows[0].count) >= 16) throw connectionError('TTS 서버는 최대 16개까지 추가할 수 있어요.', 409);
      }
      const connectionId = id ?? randomUUID();
      const encrypted = encryptProviderSecret(
        loadProviderSecretMasterKey(this.config, this.env),
        JSON.stringify(value),
        this.aad(connectionId),
      );
      const result = await client.query<Row>(
        `insert into tts_connections(id,user_id,ciphertext,iv,auth_tag,key_version) values($1,$2,$3,$4,$5,$6)
         on conflict(id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=now()
         where tts_connections.user_id=excluded.user_id returning ${columns}`,
        [connectionId, this.config.defaultUserId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, keyVersion],
      );
      await client.query('commit');
      return this.public(result.rows[0], value);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async remove(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from users where id=$1 for update', [this.config.defaultUserId]);
      await this.row(id, client);
      await client.query('delete from tts_connections where id=$1 and user_id=$2', [id, this.config.defaultUserId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async probe(input: unknown, signal: AbortSignal, id?: string): Promise<TTSConnectionDiscovery> {
    let value = normalizeTTSConnection(input, true);
    if (id) {
      const previous = this.decode(await this.row(id));
      if (value.apiKey === undefined && previous.apiKey) {
        if (new URL(value.url).origin !== new URL(previous.url).origin)
          throw connectionError('서버 주소가 바뀌었어요. API 키를 다시 입력하거나 지워 주세요.');
        value = { ...value, apiKey: previous.apiKey };
      }
    }
    return discoverTTSConnection(value, signal, this.network);
  }
  async sources(): Promise<PlainTTSSource[]> {
    const rows = await this.rows();
    return rows.flatMap((row) => {
      const value = this.decode(row);
      if (!value.enabled) return [];
      const synthesisRevision = ttsConnectionModelRevision(value),
        providerId = `connection-${row.id}`;
      const loadCurrent = async () => {
        const current = this.decode(await this.row(row.id));
        if (!current.enabled || ttsConnectionModelRevision(current) !== synthesisRevision)
          throw connectionError('TTS 서버 연결이 바뀌었어요. 다시 재생해 주세요.', 409);
        return current;
      };
      const checkCurrent = async () => {
        await loadCurrent();
      };
      return [
        {
          id: providerId,
          name: value.name,
          modelId: value.modelId,
          paid: value.paid,
          revision: structuredIntegrityHash(row.ciphertext),
          synthesisRevision,
          createProvider: async () => {
            return new ConnectionTTSProvider(providerId, await loadCurrent(), checkCurrent, this.network);
          },
        },
      ];
    });
  }
}

export async function discoverTTSConnection(
  value: TTSConnectionInput,
  signal: AbortSignal,
  network: LocalEndpointEgressOptions = {},
): Promise<TTSConnectionDiscovery> {
  const url = new URL(value.url);
  const root = url.pathname.replace(value.protocol === 'openai' ? /\/audio\/speech$/ : /\/synthesize$/, '');
  const read = async (suffix: string): Promise<unknown> => {
    const target = new URL(url);
    target.pathname = root + suffix;
    let response: Response;
    try {
      response = await requestLocalEndpoint(
        target.toString(),
        {
          method: 'GET',
          signal,
          headers: value.apiKey ? { Authorization: `Bearer ${value.apiKey}` } : {},
        },
        { ...network, allowedHosts: [url.hostname], maxResponseBytes: 256 * 1024 },
      );
    } catch {
      if (signal.aborted) throw connectionError('연결 확인을 취소했거나 응답 시간이 초과됐어요.', 408);
      throw connectionError('서버에 연결하지 못했어요. 주소와 서버 실행 상태를 확인해 주세요.', 502);
    }
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel();
      return undefined;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw connectionError('인증하지 못했어요. API 키를 확인해 주세요.', 400);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw connectionError(`서버가 연결 확인에 응답하지 못했어요. (HTTP ${response.status})`, 502);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) throw connectionError('서버의 목록 응답이 너무 커요.', 502);
    try {
      return JSON.parse(text);
    } catch {
      throw connectionError('서버가 올바른 목록을 보내지 않았어요. API 주소를 확인해 주세요.', 502);
    }
  };
  const modelsBody = value.protocol === 'openai' ? await read('/models') : undefined;
  let voicesBody = await read('/voices');
  if (voicesBody === undefined && value.protocol === 'openai') voicesBody = await read('/audio/voices');
  const array = (body: unknown, key: string): unknown[] => {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      const r = body as Record<string, unknown>;
      if (Array.isArray(r[key])) return r[key] as unknown[];
      if (Array.isArray(r.data)) return r.data;
    }
    return [];
  };
  const valid = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    !!v.trim() &&
    v.length <= max &&
    !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !(value.apiKey && v.includes(value.apiKey));
  const models = array(modelsBody, 'models')
    .slice(0, 256)
    .flatMap((m) => {
      const id = typeof m === 'string' ? m : m && typeof m === 'object' ? (m as Record<string, unknown>).id : undefined;
      return valid(id, 200) ? [id.trim()] : [];
    });
  const voices: TTSConnectionVoice[] = array(voicesBody, 'voices')
    .slice(0, 64)
    .flatMap((v) => {
      const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : { id: v };
      const id = r.id ?? r.voiceId ?? r.voice_id;
      if (!valid(id, 160)) return [];
      const label = r.label ?? r.name,
        lang = r.lang ?? r.language;
      return [
        { id: id.trim(), label: valid(label, 120) ? label.trim() : id.trim(), lang: valid(lang, 40) ? lang : 'und' },
      ];
    });
  return { models: [...new Set(models)], voices: [...new Map(voices.map((v) => [v.id, v])).values()] };
}
