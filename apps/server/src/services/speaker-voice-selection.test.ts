import { describe, expect, it } from 'vitest';
import type { SpeakerChapter, SpeakerLabel } from '../../../../src/providers/speaker-engine-protocol';
import { castingRevision, normalizeSpeakerEngine, speakerRevision } from '../providers/speaker-engine-config';
import {
  normalizeCasting,
  parseVoiceDecisions,
  selectionPrompt,
  stableVoice,
  type VoiceCandidate,
} from './speaker-voice-selection';

const candidates: VoiceCandidate[] = [
  {
    voiceId: 'local:soft',
    alias: '부드러운 목소리',
    timbre: '따뜻함',
    description: '차분한 합성 목소리',
    language: 'ko',
  },
  { voiceId: 'local:bright', alias: '밝은 목소리', timbre: '밝음', description: '', language: 'ko' },
];
const decision = (speakerId = 'speaker-one') => ({
  speakerId,
  voiceId: 'local:soft',
  importance: 'supporting' as const,
  alias: '민아',
  timbre: '중립적',
  description: '본문에서 확인한 인물',
  designPrompt: '',
});
const raw = (assignments: unknown) => JSON.stringify({ assignments });

describe('independent speaker voice selection', () => {
  it('accepts each exact speaker and supplied voice once without inventing provider IDs', () => {
    const assignments = [decision(), { ...decision('speaker-two'), voiceId: 'local:bright', importance: 'extra' }];
    expect(parseVoiceDecisions(raw(assignments), ['speaker-one', 'speaker-two'], candidates, false)).toEqual(
      assignments,
    );
    for (const invalid of [
      [],
      [decision(), decision()],
      [decision('foreign'), decision('speaker-two')],
      [{ ...decision(), voiceId: 'voice_invented_by_model' }, decision('speaker-two')],
      [decision(), decision('speaker-two'), decision('speaker-three')],
    ])
      expect(() => parseVoiceDecisions(raw(invalid), ['speaker-one', 'speaker-two'], candidates, false)).toThrow();
  });

  it('rejects malformed outputs and bounded metadata instead of silently accepting a partial selection', () => {
    for (const invalid of ['not json', 'null', '{}', raw(null)])
      expect(() => parseVoiceDecisions(invalid, ['speaker-one'], candidates, false)).toThrow();
    for (const invalid of [
      { ...decision(), importance: 'invented' },
      { ...decision(), alias: 'a'.repeat(81) },
      { ...decision(), timbre: 'a'.repeat(201) },
      { ...decision(), description: 'a'.repeat(2001) },
      { ...decision(), designPrompt: 'a'.repeat(2001), importance: 'major' },
      { ...decision(), alias: null },
    ])
      expect(() => parseVoiceDecisions(raw([invalid]), ['speaker-one'], candidates, true)).toThrow();
  });

  it('requires an existing fallback even for an allowed major design and refuses extra or supporting designs', () => {
    const designed = { ...decision(), importance: 'major', designPrompt: '낮고 따뜻한 원래 인물의 목소리' };
    expect(parseVoiceDecisions(raw([designed]), ['speaker-one'], candidates, true)).toEqual([designed]);
    for (const invalid of [
      { ...designed, importance: 'extra' },
      { ...designed, importance: 'supporting' },
      { ...designed, voiceId: '' },
      { ...designed, voiceId: 'gemini:voice_not_created' },
    ])
      expect(() => parseVoiceDecisions(raw([invalid]), ['speaker-one'], candidates, true)).toThrow();
    expect(() => parseVoiceDecisions(raw([designed]), ['speaker-one'], candidates, false)).toThrow();
  });

  it('allocates the same pool voice regardless of catalog order without mutating the input', () => {
    const before = structuredClone(candidates);
    for (const speaker of ['speaker-one', 'speaker-two', 'extra-adult', '인물-🌙']) {
      const selected = stableVoice(speaker, candidates);
      expect(candidates.map((v) => v.voiceId)).toContain(selected);
      expect(stableVoice(speaker, [...candidates].reverse())).toBe(selected);
    }
    expect(candidates).toEqual(before);
    expect(() => stableVoice('speaker-one', [])).toThrow();
  });

  it('defaults to no casting engine and validates opt-in design budgets', () => {
    expect(normalizeCasting(undefined)).toBeUndefined();
    expect(normalizeCasting({ autoDesign: false, maxDesignedVoices: 0 })).toMatchObject({
      autoDesign: false,
      maxDesignedVoices: 0,
    });
    const explicit = {
      engineId: 'chosen-casting',
      autoDesign: true,
      designProviderId: 'chosen-provider',
      designModelId: 'chosen-design-model',
      maxDesignedVoices: 2,
    };
    expect(normalizeCasting(explicit)).toEqual(explicit);
    for (const invalid of [
      null,
      [],
      {},
      { autoDesign: false, maxDesignedVoices: -1 },
      { autoDesign: false, maxDesignedVoices: 9 },
      { autoDesign: false, maxDesignedVoices: 0.5 },
      { ...explicit, engineId: undefined },
      { ...explicit, maxDesignedVoices: 0 },
      { ...explicit, designProviderId: '' },
      { ...explicit, designModelId: '' },
    ])
      expect(() => normalizeCasting(invalid)).toThrow();
  });

  it('keeps selection revisions independent of the attribution-service address and presentation labels', () => {
    const base = normalizeSpeakerEngine({
      purpose: 'casting',
      name: 'Fixture',
      engineUrl: 'http://engine.invalid',
      protocol: 'openai',
      url: 'http://model.invalid/v1',
      modelId: 'user-chosen-model',
      maxOutputTokens: 4096,
      enabled: true,
      paid: false,
    });
    const moved = {
      ...base,
      engineUrl: 'http://different-engine.invalid',
      engineToken: 'changed',
      apiKey: 'changed',
      name: 'Renamed',
    };
    expect(castingRevision(moved)).toBe(castingRevision(base));
    expect(speakerRevision(moved)).not.toBe(speakerRevision(base));
    expect(castingRevision({ ...base, modelId: 'other-model' })).not.toBe(castingRevision(base));
  });

  it('retains disabled design preferences and incomplete editor values while keeping estimate validation strict', () => {
    const draft = {
      engineId: 'casting',
      autoDesign: true,
      designProviderId: 'designer',
      designModelId: '',
      maxDesignedVoices: 1,
    };
    expect(normalizeCasting(draft, true)).toEqual(draft);
    expect(() => normalizeCasting(draft)).toThrow();
    const disabled = { ...draft, autoDesign: false, designModelId: 'saved-design-model' };
    expect(normalizeCasting(disabled, true)).toEqual(disabled);
    const maximum = { ...draft, designModelId: 'saved-design-model', maxDesignedVoices: 8 };
    expect(normalizeCasting(maximum)).toEqual(maximum);
  });

  it('sends bounded source evidence and candidate metadata as data, excluding uncertain labels', () => {
    const chapter: SpeakerChapter = {
      id: 'chapter',
      index: 1,
      title: 'Fixture',
      paragraphs: [{ id: 'p', index: 1, text: '앞'.repeat(250) + '말'.repeat(400) + '뒤'.repeat(250) }],
    };
    const labels: SpeakerLabel[] = Array.from({ length: 5 }, () => ({
      paragraphId: 'p',
      startOffset: 250,
      endOffset: 650,
      textHash: 'fixture',
      speakerId: 'speaker-one',
      reviewRequired: false,
    }));
    labels.push({ ...labels[0], speakerId: 'speaker-two', reviewRequired: true });
    const packet = JSON.parse(
      selectionPrompt(
        chapter,
        labels,
        [
          { id: 'speaker-one', name: '민아', reviewRequired: false },
          { id: 'speaker-two', name: '화자 미정', reviewRequired: true },
        ],
        candidates,
        false,
      ),
    );
    expect(packet.allowDesign).toBe(false);
    expect(packet.candidates).toEqual(candidates);
    expect(packet.characters[0].evidence).toHaveLength(3);
    expect(packet.characters[0].evidence[0].dialogue.length).toBeLessThanOrEqual(300);
    expect(packet.characters[0].evidence[0].context.length).toBeLessThanOrEqual(600);
    expect(packet.characters[1].evidence).toEqual([]);
  });
});

describe('explicit natural voice creation', () => {
  it('retains the opt-in mode, rejects contradictions, and requires stable prompts for major/supporting characters', () => {
    const settings = {
      engineId: 'casting',
      autoDesign: true,
      designMode: 'characters' as const,
      designProviderId: 'gemini',
      designModelId: 'gemini-3.8-flash-tts',
      maxDesignedVoices: 2,
    };
    expect(normalizeCasting(settings)).toEqual(settings);
    expect(() => normalizeCasting({ ...settings, autoDesign: false })).toThrow();
    expect(() => normalizeCasting({ ...settings, designMode: 'other' })).toThrow();
    const d = { ...decision(), designPrompt: 'A warm, steady adult voice with clear articulation.' };
    expect(parseVoiceDecisions(raw([d]), ['speaker-one'], candidates, true, 'characters')).toEqual([d]);
    for (const importance of ['major', 'supporting'])
      expect(() =>
        parseVoiceDecisions(
          raw([{ ...d, importance, designPrompt: '  ' }]),
          ['speaker-one'],
          candidates,
          true,
          'characters',
        ),
      ).toThrow();
    expect(() =>
      parseVoiceDecisions(raw([{ ...d, importance: 'extra' }]), ['speaker-one'], candidates, true, 'characters'),
    ).toThrow();
  });
});
