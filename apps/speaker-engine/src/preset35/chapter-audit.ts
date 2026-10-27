import type { PreparedChapterSpeakerRun, SpeakerChapterLabelV1 } from './chapter-context-speaker';
export interface ChapterAuditInput {
  prepared: PreparedChapterSpeakerRun;
  checkpoint: { runId: string; inputFingerprint: string; status: 'succeeded'; finalLabels: SpeakerChapterLabelV1 };
  chapterTitle: string;
}
