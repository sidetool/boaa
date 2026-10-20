import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  translationSourceLanguage,
  translationTextParagraphs,
  type TranslationConfiguration,
  type TranslationParagraph,
  type TranslationRequest,
  type TranslationResult,
  type TranslationSettings,
} from '../../../../src/translation/contracts.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  loadProviderSecretMasterKey,
} from '../providers/server-provider-secrets.js';
import { parseGoogleServiceAccount } from '../providers/google-service-account.js';
import { TranslationError } from './engine.js';

export interface TranslationRow {
  id: string;
  kind: 'chapter' | 'titles';
  user_id: string;
  book_id: string | null;
  content_revision_id: string | null;
  work_key: string;
  chapter_key: string;
  source_hash: string;
  profile_hash: string;
  settings: TranslationSettings;
  input: TranslationParagraph[];
  output: TranslationParagraph[];
  completed: number;
  status: TranslationResult['status'];
  error_code: string | null;
  execution_id: string | null;
  created_at: Date;
}
type Queryable = Pick<pg.Pool, 'query'>;
export const hashTranslation = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function presentTranslation(row: TranslationRow): TranslationResult {
  return {
    id: row.id,
    workKey: row.work_key,
    chapterKey: row.chapter_key,
    sourceHash: row.source_hash,
    status: row.status,
    targetLanguage: row.settings.targetLanguage,
    provider: row.settings.provider,
    model: row.settings.model,
    paragraphs: row.output,
    completed: row.completed,
    total: row.input.filter((p) => p.text.trim()).length,
    ...(row.error_code ? { error: row.error_code } : {}),
  };
}
export async function translationConfiguration(pool: Queryable, userId: string): Promise<TranslationConfiguration> {
  const [settings, credentials, usage] = [
    await pool.query('select settings, revision from translation_settings where user_id=$1', [userId]),
    await pool.query('select provider from translation_credentials where user_id=$1', [userId]),
    await pool.query('select characters from translation_daily_usage where user_id=$1 and day=current_date', [userId]),
  ];
  return {
    settings: Object.fromEntries(
      Object.entries(DEFAULT_TRANSLATION_SETTINGS).map(([key, fallback]) => [
        key,
        settings.rows[0]?.settings?.[key] ?? fallback,
      ]),
    ) as TranslationSettings,
    revision: settings.rows[0]?.revision ?? 0,
    credentials: Object.fromEntries(credentials.rows.map((row) => [row.provider, { saved: true }])),
    usedCharacters: Number(usage.rows[0]?.characters ?? 0),
  };
}
export async function saveTranslationCredential(
  pool: Queryable,
  config: ServerConfig,
  userId: string,
  provider: string,
  value: string,
) {
  if (!['gemini', 'vertex', 'openai-compatible'].includes(provider) || !value.trim() || value.length > 65536)
    throw new TranslationError('translation_invalid_settings');
  if (provider === 'vertex') value = JSON.stringify(parseGoogleServiceAccount(value));
  else if (value.length > 4096 || /[\r\n]/.test(value)) throw new TranslationError('translation_invalid_settings');
  const sealed = encryptProviderSecret(
    loadProviderSecretMasterKey(config, process.env),
    value.trim(),
    `${userId}:text_translation:${provider}`,
  );
  await pool.query(
    `insert into translation_credentials(user_id,provider,ciphertext,iv,auth_tag,key_version) values($1,$2,$3,$4,$5,'local-aes-256-gcm-v1') on conflict(user_id,provider) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=now()`,
    [userId, provider, sealed.ciphertext, sealed.iv, sealed.authTag],
  );
}
export async function readTranslationCredential(
  pool: Queryable,
  config: ServerConfig,
  userId: string,
  provider: string,
): Promise<string> {
  const result = await pool.query('select * from translation_credentials where user_id=$1 and provider=$2', [
    userId,
    provider,
  ]);
  if (!result.rows[0]) throw new TranslationError('translation_secret_required');
  return decryptProviderSecret(
    loadProviderSecretMasterKey(config, process.env),
    result.rows[0],
    `${userId}:text_translation:${provider}`,
  );
}
export function validateTranslationParagraphs(value: unknown): TranslationParagraph[] {
  if (!Array.isArray(value) || !value.length || value.length > 10000)
    throw new TranslationError('translation_invalid_settings');
  const ids = new Set<string>();
  let characters = 0;
  const result = value.map((p) => {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 300 || ids.has(p.id) || typeof p.text !== 'string')
      throw new TranslationError('translation_invalid_settings');
    ids.add(p.id);
    characters += p.text.length;
    if (characters > 500000) throw new TranslationError('translation_invalid_settings');
    return { id: p.id, text: p.text };
  });
  if (!result.some((p) => p.text.trim())) throw new TranslationError('translation_invalid_settings');
  return result;
}
/** All settings, credential and request mutations share an account transaction boundary. */
export async function withTranslationOwnerTransaction<T>(
  pool: pg.Pool,
  userId: string,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 9861))', [userId]);
    const value = await action(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
/** Read source and revision under one transaction, with the same book write lock as replacement. */
export async function requestTranslation(
  pool: pg.Pool,
  userId: string,
  request: TranslationRequest,
): Promise<TranslationRow | undefined> {
  if (
    !request ||
    ![request.workKey, request.chapterKey].every((key) => typeof key === 'string' && key.length > 0 && key.length < 500)
  )
    throw new TranslationError('translation_invalid_settings');
  if (
    (request.sourceLanguage !== undefined &&
      (typeof request.sourceLanguage !== 'string' ||
        !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(request.sourceLanguage))) ||
    ['lookupOnly', 'prefetch', 'confirmUnknownLanguage'].some(
      (key) =>
        (request as unknown as Record<string, unknown>)[key] !== undefined &&
        typeof (request as unknown as Record<string, unknown>)[key] !== 'boolean',
    ) ||
    (request.bookId !== undefined &&
      (typeof request.bookId !== 'string' || !request.bookId || request.bookId.length > 500)) ||
    (request.revision !== undefined && (typeof request.revision !== 'string' || request.revision.length > 500)) ||
    (request.chapterTextHash !== undefined &&
      (typeof request.chapterTextHash !== 'string' || !request.chapterTextHash || request.chapterTextHash.length > 500))
  )
    throw new TranslationError('translation_invalid_settings');
  return withTranslationOwnerTransaction(pool, userId, async (client) => {
    const configuration = await translationConfiguration(client, userId);
    const settings = configuration.settings;
    if (!settings.enabled) throw new TranslationError('translation_disabled');
    let paragraphs: TranslationParagraph[],
      sourceLanguage = request.sourceLanguage;
    let contentRevision = request.revision ?? null;
    if (request.bookId) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 7319))', [request.bookId]);
      const book = await client.query(
        `select b.language, b.active_content_revision_id from library_books b join chapters c on c.book_id=b.id where b.id=$1 and b.user_id=$2 and b.deleted_at is null and b.format in ('txt','markdown','epub') and c.id=$4 and ($5::text is null or c.text_hash=$5) and (b.active_content_revision_id is not distinct from $3::text or ($5::text is not null and c.text_hash=$5 and exists(select 1 from book_content_revisions r where r.id=$3 and r.book_id=b.id)))`,
        [request.bookId, userId, request.revision ?? null, request.chapterKey, request.chapterTextHash ?? null],
      );
      if (!book.rows.length || request.workKey !== request.bookId)
        throw new TranslationError('translation_source_changed');
      sourceLanguage = sourceLanguage || book.rows[0].language;
      contentRevision = book.rows[0].active_content_revision_id;
      const pages = await client.query(
        'select paragraphs from paragraph_pages where book_id=$1 and chapter_id=$2 order by page_index',
        [request.bookId, request.chapterKey],
      );
      paragraphs = validateTranslationParagraphs(translationTextParagraphs(pages.rows.flatMap((p) => p.paragraphs)));
    } else paragraphs = validateTranslationParagraphs(request.paragraphs);
    // Include storage provenance: a transient snapshot must never bypass a saved book's fences.
    const sourceHash = hashTranslation({ bookId: request.bookId ?? null, paragraphs });
    const legacySourceHash = hashTranslation(paragraphs);
    const profileHash = hashTranslation({
      version: 1,
      provider: settings.provider,
      model: settings.model,
      endpoint: settings.endpoint,
      project: settings.project,
      location: settings.location,
      targetLanguage: settings.targetLanguage,
      instructions: settings.instructions,
      glossary: settings.glossary,
    });
    const existing = await client.query<TranslationRow>(
      `select * from translation_jobs where kind='chapter' and user_id=$1 and work_key=$2 and chapter_key=$3 and source_hash in ($4,$6) and profile_hash=$5 and book_id is not distinct from $7::text order by (source_hash=$4) desc limit 1`,
      [userId, request.workKey, request.chapterKey, sourceHash, profileHash, legacySourceHash, request.bookId ?? null],
    );
    let row = existing.rows[0];
    if (request.lookupOnly || (row && ['queued', 'running', 'complete'].includes(row.status))) {
      return row;
    }
    sourceLanguage = translationSourceLanguage(sourceLanguage, paragraphs.map((p) => p.text).join('\n'));
    if (sourceLanguage?.split('-')[0].toLowerCase() === settings.targetLanguage.split('-')[0].toLowerCase())
      throw new TranslationError('translation_same_language');
    if (!sourceLanguage && !request.confirmUnknownLanguage)
      throw new TranslationError('translation_language_confirmation');
    if (!configuration.credentials[settings.provider]?.saved) throw new TranslationError('translation_secret_required');
    const pending = await client.query(
      "select count(*) from translation_jobs where user_id=$1 and status in ('queued','running')",
      [userId],
    );
    if (Number(pending.rows[0].count) >= 8) throw new TranslationError('translation_busy');
    if (row) {
      const resumed = await client.query<TranslationRow>(
        "update translation_jobs set status='queued',error_code=null,execution_id=null,settings=$3,updated_at=now(),prefetch=$4,content_revision_id=$5 where id=$1 and user_id=$2 returning *",
        [row.id, userId, settings, request.prefetch === true, contentRevision],
      );
      row = resumed.rows[0];
    } else {
      const inserted = await client.query<TranslationRow>(
        `insert into translation_jobs(id,user_id,book_id,content_revision_id,work_key,chapter_key,source_hash,profile_hash,settings,input,input_characters,prefetch) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [
          randomUUID(),
          userId,
          request.bookId ?? null,
          contentRevision,
          request.workKey,
          request.chapterKey,
          sourceHash,
          profileHash,
          settings,
          JSON.stringify(paragraphs),
          paragraphs.reduce((sum, p) => sum + p.text.length, 0),
          request.prefetch === true,
        ],
      );
      row = inserted.rows[0];
    }
    return row;
  });
}
/** Account for every provider attempt, including retries; there is no application daily quota. */
export async function chargeTranslation(pool: Queryable, row: Pick<TranslationRow, 'user_id'>, characters: number) {
  await pool.query(
    `insert into translation_daily_usage(user_id,characters) values($1,$2)
     on conflict(user_id,day) do update set characters=translation_daily_usage.characters+excluded.characters`,
    [row.user_id, characters],
  );
}
/** The book revision also advances when unrelated downloaded chapters are appended.
 * Owner/deletion/chapter existence and exact normalized input are always required.
 * Revision tokens and chapter text hashes alone do not prove paragraph identity.
 * Job rows cascade on book purge, so a later book incarnation cannot inherit this proof.
 */
export const translationSourceCurrentSql = `(j.book_id is null or exists (
  select 1 from library_books b join chapters c on c.book_id=b.id and c.id=j.chapter_key
  where b.id=j.book_id and b.user_id=j.user_id and b.deleted_at is null and (
    coalesce((select jsonb_agg(jsonb_build_object('id',p.value->>'id','text',p.value->>'text') order by pp.page_index,p.ordinality)
      from paragraph_pages pp cross join lateral jsonb_array_elements(pp.paragraphs) with ordinality p(value,ordinality)
      where pp.book_id=j.book_id and pp.chapter_id=j.chapter_key
        and coalesce(p.value->>'documentKind','') not in ('image','separator')), '[]'::jsonb) = j.input
  )
))`;
export async function translationIsCurrent(pool: Queryable, row: TranslationRow, execution: string): Promise<boolean> {
  const result = await pool.query(
    `select j.id from translation_jobs j join translation_settings s on s.user_id=j.user_id where j.id=$1 and j.execution_id=$2 and j.status='running' and (s.settings->>'enabled')::boolean and (j.kind <> 'titles' or coalesce((s.settings->>'translateTitles')::boolean,false)) and not exists(select 1 from self_host_accounts a where a.user_id=j.user_id and a.status<>'active') and ${translationSourceCurrentSql}`,
    [row.id, execution],
  );
  return result.rows.length > 0;
}
