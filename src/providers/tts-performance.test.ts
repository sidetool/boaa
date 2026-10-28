import { expect, it } from 'vitest';
import { isGeminiActingModel, NEUTRAL_PERFORMANCE, parsePerformance, performanceStyle } from './tts-performance';

it('keeps automatic acting strict, provider-neutral and neutral instructions empty', () => {
  expect(parsePerformance(NEUTRAL_PERFORMANCE)).toEqual(NEUTRAL_PERFORMANCE);
  expect(performanceStyle(undefined)).toBeUndefined();
  expect(performanceStyle(NEUTRAL_PERFORMANCE)).toBeUndefined();
  expect(performanceStyle({ emotion: 'angry', delivery: 'normal', pace: 'fast', intensity: 'moderate' })).toBe(
    'angry, speaking quickly',
  );
  for (const value of [
    null,
    [],
    {},
    { ...NEUTRAL_PERFORMANCE, identity: 'unknown' },
    { ...NEUTRAL_PERFORMANCE, pace: 'very-fast' },
    { ...NEUTRAL_PERFORMANCE, intensity: null },
  ])
    expect(() => parsePerformance(value)).toThrow();
  for (const id of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) expect(isGeminiActingModel(id)).toBe(true);
  for (const id of [
    undefined,
    'gemini-3.1-flash-tts-preview',
    'gemini-3.8-flash-tts-preview',
    'gemini-3.8-custom-tts',
    'gemini-3.8-flash-lite-tts-fake',
  ])
    expect(isGeminiActingModel(id)).toBe(false);
});
