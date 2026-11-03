import type { FishSpeechModel } from './tts-connections';
import type { SpeakerPerformance } from './tts-performance';

/** S2/S2.1 documented emotion and delivery cues. Sound effects are deliberately not actor directions. */
export const S2_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'excited',
  'calm',
  'nervous',
  'confident',
  'surprised',
  'satisfied',
  'delighted',
  'scared',
  'worried',
  'upset',
  'frustrated',
  'depressed',
  'empathetic',
  'embarrassed',
  'disgusted',
  'moved',
  'proud',
  'relaxed',
  'grateful',
  'curious',
  'sarcastic',
  'disdainful',
  'unhappy',
  'anxious',
  'hysterical',
  'indifferent',
  'uncertain',
  'doubtful',
  'confused',
  'disappointed',
  'regretful',
  'guilty',
  'ashamed',
  'jealous',
  'envious',
  'hopeful',
  'optimistic',
  'pessimistic',
  'nostalgic',
  'lonely',
  'bored',
  'contemptuous',
  'sympathetic',
  'compassionate',
  'determined',
  'resigned',
] as const;
export const S2_TONES = ['whispering', 'shouting', 'soft tone', 'in a hurry tone'] as const;
export const S2_TAGS = [...S2_EMOTIONS, ...S2_TONES] as const;
export interface SpeakerDirection {
  format: FishSpeechModel;
  tags: string[];
  text: string;
}
export const DIRECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tags', 'text'],
  properties: {
    tags: { type: 'array', maxItems: 2, items: { type: 'string', enum: S2_TAGS } },
    text: { type: 'string', maxLength: 240 },
  },
};
export const DIRECTION_INSTRUCTION = [
  'This is a dedicated acting pass AFTER speaker attribution. All speaker IDs, identities and target text are fixed; never relabel, rewrite, merge or omit a target.',
  'Read the complete chapter, including narration and dialogue before AND after each target. Keep adjacent scenes separate. Use who speaks to whom, concealed intentions, quotation and the later response to distinguish sarcasm, reassurance, concealed anger and literal emotion. Do not narrate that context aloud.',
  'Return the ordinary four-field acting object plus a separate direction object {tags:[], text:""} for EVERY target. The target format controls direction; formats may differ within a batch.',
  `For fish-s2 (S2 Pro and S2.1 Pro, including Free), choose at most one emotion and one delivery cue from these documented cues: ${S2_TAGS.join(', ')}. Use exact names in tags without brackets; text must be empty. Prefer a precise mild emotion such as uncertain, worried, resigned or empathetic over an exaggerated happy/sad/angry label. Avoid hysterical/depressed unless explicitly audible. Ordinary speech needs tags:[], not a compulsory emotion. The server supplies intensity and pace from acting.`,
  'For fish-drama (Drama 3), tags must be empty. Write one concise natural-language actor direction in text (max 240 characters, preferably under 120) only if context supports it. Describe audible delivery and relevant intent toward the listener, not a plot synopsis. Use the script language or simple English. No brackets, markup, speaker labels, quotations of the line, new spoken words, identity, gender, age, timbre, accent or voice replacement. Normal narration/uncertain delivery should have empty text.',
  'For plain, leave both direction fields empty; the ordinary acting fields are rendered by that provider.',
  'Do not invent sound effects, laughter, breaths, sighs, silence, background sounds, language switches or phoneme tags. Drama3 supports paired word tags, but this line-level contract does NOT: never output angle brackets or rewrite target text. Do not slow a line for sadness or hesitation; direction must agree with acting.pace. Keep subtle intensity restrained and conversational.',
].join(' ');

/** Strict provider-specific validation before a generated direction can enter an audio request. */
export function parseDirection(value: unknown, format?: FishSpeechModel): SpeakerDirection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_speaker_direction');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    !Array.isArray(v.tags) ||
    typeof v.text !== 'string' ||
    v.text.length > 240 ||
    v.tags.length > 2 ||
    new Set(v.tags).size !== v.tags.length ||
    v.tags.some((t) => typeof t !== 'string' || !(S2_TAGS as readonly string[]).includes(t)) ||
    Array.from(v.text).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /[<>[\]]/.test(v.text)
  )
    throw new Error('invalid_speaker_direction');
  const tags = v.tags as string[],
    text = v.text.trim();
  if (format === 'fish-s2') {
    if (
      text ||
      tags.filter((t) => (S2_EMOTIONS as readonly string[]).includes(t)).length > 1 ||
      tags.filter((t) => (S2_TONES as readonly string[]).includes(t)).length > 1
    )
      throw new Error('invalid_s2_direction');
  } else if (format === 'fish-drama') {
    if (tags.length) throw new Error('invalid_drama_direction');
  } else if (tags.length || text) throw new Error('unexpected_speaker_direction');
  return format && (tags.length || text) ? { format, tags, text } : undefined;
}

export function directionCues(direction: SpeakerDirection, performance: SpeakerPerformance): string[] {
  const valid = parseDirection({ tags: direction.tags, text: direction.text }, direction.format);
  if (!valid) return [];
  if (valid.format === 'fish-drama')
    return [valid.text, ...(performance.intensity === 'subtle' ? ['restrained delivery'] : [])];
  return valid.tags.map((tag) =>
    performance.intensity === 'subtle' && (S2_EMOTIONS as readonly string[]).includes(tag) ? `slightly ${tag}` : tag,
  );
}
