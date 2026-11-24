import type { SegmentType } from '../../domain/types';
import type { CONTROLLED_TTS_EMOTIONS } from '../../providers/chapter-labeling-contract';
import type {
  CONTROLLED_TTS_DELIVERIES,
  CONTROLLED_TTS_INTENSITIES,
  CONTROLLED_TTS_PACES,
} from '../../providers/chapter-labeling-v2-contract';

type ReviewValue =
  | SegmentType
  | (typeof CONTROLLED_TTS_EMOTIONS)[number]
  | (typeof CONTROLLED_TTS_DELIVERIES)[number]
  | (typeof CONTROLLED_TTS_INTENSITIES)[number]
  | (typeof CONTROLLED_TTS_PACES)[number];

const labels = {
  narration: '서술',
  quoted_dialogue: '따옴표 대사',
  plain_dialogue: '일반 대사',
  inner_monologue: '속마음',
  system_message: '시스템 메시지',
  sfx: '효과음',
  author_note: '작가의 말',
  unknown: '미정',
  neutral: '중립',
  calm: '차분함',
  tense: '긴장',
  angry: '분노',
  irritated: '짜증',
  sad: '슬픔',
  happy: '기쁨',
  excited: '들뜸',
  afraid: '두려움',
  surprised: '놀람',
  confused: '혼란',
  whisper: '속삭임',
  shout: '외침',
  system: '시스템',
  slow: '느리게',
  normal: '보통',
  fast: '빠르게',
  low: '약하게',
  medium: '보통',
  high: '강하게',
  soft: '부드럽게',
  firm: '단호하게',
  trembling: '떨리는 목소리',
} satisfies Record<ReviewValue, string>;

export function reviewValueLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value as ReviewValue] : value;
}
