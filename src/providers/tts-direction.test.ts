import { expect, it } from 'vitest';
import { parseDirection, DIRECTION_INSTRUCTION, S2_TAGS } from './tts-direction';
import { performanceStyle, NEUTRAL_PERFORMANCE } from './tts-performance';
import { fishDirection, fishLiteralText } from './fish-performance';

it('validates S2/S2.1 cues independently from Drama natural-language directions', () => {
  const s2 = parseDirection({ tags: ['uncertain', 'soft tone'], text: '' }, 'fish-s2')!;
  expect(performanceStyle(NEUTRAL_PERFORMANCE, 'fish-s2', s2)).toBe(
    '[slightly uncertain][soft tone][normal conversational pace]',
  );
  const drama = parseDirection({ tags: [], text: '상대를 안심시키되 걱정은 감추며' }, 'fish-drama')!;
  const rendered = performanceStyle(NEUTRAL_PERFORMANCE, 'fish-drama', drama)!;
  expect(rendered).toBe('[상대를 안심시키되 걱정은 감추며, restrained delivery, normal conversational pace]');
  expect(fishDirection(rendered)).toBe(rendered);
  expect(fishLiteralText('[괜찮아요.]')).toBe('［괜찮아요.］');
  expect(performanceStyle(NEUTRAL_PERFORMANCE, 'fish-s2', drama)).toBeUndefined();
  expect(DIRECTION_INSTRUCTION).toContain('S2 Pro and S2.1 Pro');
  expect(S2_TAGS).not.toContain('sighing');
});

it('rejects wrong-model, invented, conflicting, sound-effect and markup directions', () => {
  for (const value of [
    { tags: ['unknown'], text: '' },
    { tags: ['happy', 'sad'], text: '' },
    { tags: ['shouting', 'whispering'], text: '' },
    { tags: ['sighing'], text: '' },
    { tags: ['happy'], text: 'arbitrary' },
    { tags: ['happy', 'happy'], text: '' },
    { tags: [], text: '', extra: true },
  ])
    expect(() => parseDirection(value, 'fish-s2')).toThrow();
  for (const value of [
    { tags: ['sad'], text: '' },
    { tags: [], text: '[slow] 말하기' },
    { tags: [], text: '<emphasis>말</emphasis>' },
    { tags: [], text: '가'.repeat(241) },
    { tags: [], text: '첫째\n둘째' },
  ])
    expect(() => parseDirection(value, 'fish-drama')).toThrow();
  expect(() => parseDirection({ tags: [], text: 'direction' })).toThrow();
  expect(parseDirection({ tags: [], text: '' })).toBeUndefined();
  expect(parseDirection({ tags: [], text: '' }, 'fish-drama')).toBeUndefined();
});
