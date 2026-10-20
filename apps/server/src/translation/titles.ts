import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  shouldTranslateTitle,
  type TitleTranslationResponse,
  type TranslationSettings,
} from '../../../../src/translation/contracts.js';
import {
  hashTranslation,
  translationConfiguration,
  withTranslationOwnerTransaction,
  type TranslationRow,
} from './store.js';
import { TranslationError } from './engine.js';

function profile(settings: TranslationSettings) {
  return hashTranslation({
    purpose: 'titles-v1',
    provider: settings.provider,
    model: settings.model,
    endpoint: settings.endpoint,
    project: settings.project,
    location: settings.location,
    targetLanguage: settings.targetLanguage,
    instructions: settings.instructions,
    glossary: settings.glossary,
  });
}
/** Per-title cache identity is independent of list order, pagination and batch composition.
 * All admission is serialized with settings, credential changes and cache deletion. */
export async function requestTitleTranslations(pool: pg.Pool, owner: string, input: unknown) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 24 ||
    input.some((title) => typeof title !== 'string' || !title.trim() || title.length > 500)
  )
    throw new TranslationError('translation_invalid_settings');
  const titles = [...new Set(input as string[])];
  return withTranslationOwnerTransaction(pool, owner, async (client) => {
    const configuration = await translationConfiguration(client, owner);
    const settings = { ...configuration.settings, chunkCharacters: 12000, concurrency: 1 };
    const original = (): TitleTranslationResponse => ({
      titles: titles.map((original) => ({ original, status: 'original' })),
    });
    if (!settings.enabled || !settings.translateTitles) return { response: original(), queued: [] as TranslationRow[] };
    const candidates = titles.filter((title) => shouldTranslateTitle(title, settings.targetLanguage));
    const profileHash = profile(settings);
    const hashes = candidates.map(hashTranslation);
    const cached = await client.query<TranslationRow & { title_hash: string; can_retry: boolean }>(
      `select j.*, t.source_hash as title_hash,
        (coalesce(c.updated_at,j.updated_at) > j.updated_at or s.updated_at > j.updated_at) as can_retry
       from translation_titles t join translation_jobs j on j.id=t.job_id and j.user_id=t.user_id
       join translation_settings s on s.user_id=j.user_id
       left join translation_credentials c on c.user_id=j.user_id and c.provider=j.settings->>'provider'
       where t.user_id=$1 and t.profile_hash=$2 and t.source_hash=any($3::text[])`,
      [owner, profileHash, hashes],
    );
    const records = new Map(cached.rows.map((row) => [row.title_hash, row]));
    const queued = new Map<string, TranslationRow>();
    // Polls also repair a failed enqueue, without admitting another paid job.
    for (const row of cached.rows) if (row.status === 'queued') queued.set(row.id, row);
    const pending = await client.query<{ total: string; titles: string }>(
      `select count(*) as total, count(*) filter(where kind='titles') as titles from translation_jobs
       where user_id=$1 and status in ('queued','running')`,
      [owner],
    );
    let slots = Math.max(0, Math.min(8 - Number(pending.rows[0].total), 2 - Number(pending.rows[0].titles)));
    const canAdmit = configuration.credentials[settings.provider]?.saved;
    const resumed = new Map<string, TranslationRow>();
    if (canAdmit) {
      for (const row of cached.rows) {
        if (
          row.output.some((part) => part.id === row.title_hash) ||
          resumed.has(row.id) ||
          !slots ||
          !['cancelled', 'failed'].includes(row.status) ||
          (row.status !== 'cancelled' && !row.can_retry)
        )
          continue;
        const result = await client.query<TranslationRow>(
          `update translation_jobs set status='queued',error_code=null,execution_id=null,settings=$2,updated_at=now()
           where id=$1 returning *`,
          [row.id, settings],
        );
        resumed.set(row.id, result.rows[0]);
        queued.set(row.id, result.rows[0]);
        slots--;
      }
    }
    const missing = candidates.filter((title) => !records.has(hashTranslation(title)));
    if (canAdmit && slots > 0 && missing.length) {
      const id = randomUUID();
      const paragraphs = missing.map((text) => ({ id: hashTranslation(text), text }));
      const result = await client.query<TranslationRow>(
        `insert into translation_jobs(id,user_id,kind,work_key,chapter_key,source_hash,profile_hash,settings,input,input_characters)
         values($1,$2,'titles',$1,'titles',$3,$4,$5,$6,$7) returning *`,
        [
          id,
          owner,
          hashTranslation(paragraphs),
          profileHash,
          settings,
          JSON.stringify(paragraphs),
          missing.reduce((sum, title) => sum + title.length, 0),
        ],
      );
      const row = result.rows[0];
      await client.query(
        `insert into translation_titles(user_id,source_hash,profile_hash,job_id)
         select $1,unnest($2::text[]),$3,$4`,
        [owner, paragraphs.map((p) => p.id), profileHash, id],
      );
      for (const paragraph of paragraphs)
        records.set(paragraph.id, { ...row, title_hash: paragraph.id, can_retry: false });
      queued.set(id, row);
    }
    const response: TitleTranslationResponse = {
      titles: titles.map((original) => {
        const hash = hashTranslation(original);
        const record = records.get(hash);
        if (!record) return { original, status: candidates.includes(original) && canAdmit ? 'queued' : 'original' };
        const row = resumed.get(record.id) ?? record;
        const translated = row.output.find((part) => part.id === hash)?.text;
        const awaitingRetry =
          !resumed.has(row.id) &&
          canAdmit &&
          (record.status === 'cancelled' || (record.status === 'failed' && record.can_retry));
        return { original, translated, status: translated ? 'complete' : awaitingRetry ? 'queued' : row.status };
      }),
    };
    return { response, queued: [...queued.values()] };
  });
}
