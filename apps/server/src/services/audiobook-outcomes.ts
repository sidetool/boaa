/** Correlated through the already owner-scoped audiobook alias a. Never include source text. */
export const audioOutcomeColumns = `
 (select count(*)::int from saved_audiobook_items i where i.audiobook_id=a.id and i.status='blocked') blocked_items,
 (select count(*)::int from saved_audiobook_items i where i.audiobook_id=a.id and i.status='skipped') skipped_items,
 coalesce((select jsonb_agg(x) from (select ordinal,chapter_title as "chapterTitle",block_reason as reason
   from saved_audiobook_items where audiobook_id=a.id and status='blocked' order by ordinal limit 8) x),'[]') blocked_audio,
 coalesce((select jsonb_agg(x) from (select ordinal,chapter_title as "chapterTitle",block_reason as reason
   from saved_audiobook_items where audiobook_id=a.id and status='skipped' order by ordinal limit 8) x),'[]') skipped_audio`;
export function audioOutcomes(row: {
  blocked_items?: number;
  skipped_items?: number;
  blocked_audio?: { ordinal: number; chapterTitle: string; reason: string }[];
  skipped_audio?: { ordinal: number; chapterTitle: string; reason: string }[];
  settings: { skipBlockedAudio?: boolean };
}) {
  return {
    blockedItems: row.blocked_items ?? 0,
    skippedItems: row.skipped_items ?? 0,
    blockedAudio: row.blocked_audio ?? [],
    skippedAudio: row.skipped_audio ?? [],
    skipBlockedAudio: row.settings.skipBlockedAudio === true,
  };
}
/** Internal signal: a confirmed omission is terminal work, never failed generation or fabricated audio. */
export class AudioSkipped extends Error {
  readonly statusCode = 410;
  constructor() {
    super('콘텐츠 제한으로 건너뛴 구간이에요. 이 부분의 음성은 없어요.');
  }
}
