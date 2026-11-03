import type { SpeakerPerformance } from './tts-performance';
import type { FishSpeechModel } from './tts-connections';
import { directionCues, type SpeakerDirection } from './tts-direction';

/** Render only at the provider boundary: the book text and its stored anchors stay intact. */
export function fishLiteralText(text: string): string {
  return text.replace(/[[\]<>]/g, (c) => ({ '[': '［', ']': '］', '<': '＜', '>': '＞' })[c]!);
}

/** Both S2.1 and Drama3 accept bracket directions. Never create speaker/phoneme/control tokens here. */
export function fishDirection(instructions: string): string {
  const value = instructions.trim();
  if (!value) return '';
  const tags = [...value.matchAll(/\[([^[\]<>\r\n]+)\]/g)];
  if (tags.length && value.replace(/\[([^[\]<>\r\n]+)\]/g, '').trim() === '')
    return tags.map((tag) => `[${tag[1].trim()}]`).join('');
  return `[${value
    .replace(/[[\]<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()}]`;
}

export function fishPerformanceStyle(
  p: SpeakerPerformance,
  format: FishSpeechModel,
  direction?: SpeakerDirection,
): string | undefined {
  const emotion = p.emotion === 'afraid' ? 'scared' : p.emotion;
  const directed = direction?.format === format;
  const cues: string[] = directed ? directionCues(direction, p) : [];
  if (!directed && emotion !== 'neutral') cues.push(p.intensity === 'subtle' ? `slightly ${emotion}` : emotion);
  if (!directed && p.delivery !== 'normal') {
    const delivery = p.delivery === 'breathless' ? 'breathless voice' : p.delivery;
    cues.push(p.intensity === 'subtle' ? `restrained ${delivery}` : delivery);
  }
  if (p.pace !== 'normal') cues.push(p.pace === 'slow' ? 'slightly slower' : 'slightly faster');
  else if (cues.length) cues.push('normal conversational pace');
  if (!cues.length) return;
  // Drama3 explicitly supports a composite actor direction; S2 uses separate short cues.
  return format === 'fish-drama' ? `[${cues.join(', ')}]` : cues.map((cue) => `[${cue}]`).join('');
}
