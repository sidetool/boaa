import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { PlainTTSModel } from '../../../../src/providers/plain-tts';
import { audiobookError } from './audiobook-plan';

export interface BookVoiceUpdate {
  speakerId: string;
  name: string;
  voiceId: string;
  model: PlainTTSModel;
}

type DB = Pick<pg.Pool, 'query'>;
const bindingVersion = (row: Record<string, unknown> | undefined) => structuredIntegrityHash(row ?? null);

/** Snapshot only changed characters. Untouched assignments are never written by revoicing. */
export async function bookBindingVersions(
  db: DB,
  owner: string,
  bookId: string,
  analysisKey: string,
  ids: string[],
): Promise<Record<string, string>> {
  const rows = (
    await db.query(
      'select speaker_id,voice_id,model,metadata,pinned,updated_at from speaker_voice_bindings where user_id=$1 and book_id=$2 and analysis_key=$3 and speaker_id=any($4::text[])',
      [owner, bookId, analysisKey, ids],
    )
  ).rows;
  return Object.fromEntries(ids.map((id) => [id, bindingVersion(rows.find((r) => r.speaker_id === id))]));
}

/** Called inside the job-creation or design-acceptance transaction, after account/source checks. */
export async function applyBookVoiceUpdates(
  db: DB,
  owner: string,
  bookId: string,
  analysisKey: string,
  updates: BookVoiceUpdate[],
  expected: Record<string, string>,
) {
  for (const update of [...updates].sort((a, b) => a.speakerId.localeCompare(b.speakerId))) {
    if (update.speakerId === 'narrator' || !expected[update.speakerId])
      throw audiobookError(409, '바꿀 인물 목소리를 다시 확인해 주세요.');
    const keys = [owner, bookId, analysisKey, update.speakerId];
    const row = (
      await db.query(
        'select speaker_id,voice_id,model,metadata,pinned,updated_at from speaker_voice_bindings where user_id=$1 and book_id=$2 and analysis_key=$3 and speaker_id=$4 for update',
        keys,
      )
    ).rows[0];
    if (bindingVersion(row) !== expected[update.speakerId])
      throw audiobookError(409, '그동안 작품의 인물 목소리가 바뀌었어요. 현재 설정을 확인하고 다시 만들어 주세요.');
    const saved = (
      await db.query('select metadata from tts_voice_library where user_id=$1 and voice_id=$2', [owner, update.voiceId])
    ).rows[0]?.metadata;
    const metadata = {
      importance: row?.metadata?.importance ?? 'supporting',
      alias: saved?.alias ?? update.name,
      timbre: saved?.timbre ?? '',
      description: saved?.description ?? '',
      designPrompt: '',
    };
    const values = [...keys, update.name, update.voiceId, update.model, metadata];
    const result = row
      ? await db.query(
          'update speaker_voice_bindings set name=$5,voice_id=$6,model=$7,metadata=$8,pinned=true,updated_at=now() where user_id=$1 and book_id=$2 and analysis_key=$3 and speaker_id=$4',
          values,
        )
      : await db.query(
          'insert into speaker_voice_bindings(user_id,book_id,analysis_key,speaker_id,name,voice_id,model,metadata,pinned) values($1,$2,$3,$4,$5,$6,$7,$8,true) on conflict do nothing',
          values,
        );
    if (!result.rowCount) throw audiobookError(409, '작품의 인물 목소리가 바뀌었어요. 다시 확인해 주세요.');
  }
}
