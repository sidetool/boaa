import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type {
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerRevoiceSource,
} from '../../providers/speaker-generation';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import type { VoiceDesignProvider } from '../../providers/voice-library';
import UiNextSpeakerRevoice from './UiNextSpeakerRevoice';

// Neutral synthetic fixtures only.
const voices: PlainTTSVoice[] = [
  { id: 'a1', lang: 'ko', label: '목소리 1', providerId: 'tts-a', providerName: '엔진 A' },
  {
    id: 'a2',
    lang: 'ko',
    label: '목소리 2',
    providerId: 'tts-g',
    providerName: '엔진 G',
    instructionsSupported: true,
    modelId: 'other-instruct-tts',
  },
  {
    id: 'a3',
    lang: 'ko',
    label: '목소리 3',
    providerId: 'tts-g',
    providerName: '엔진 G',
    instructionsSupported: true,
    modelId: 'gemini-3.8-flash-lite-tts',
  },
  { id: 'b1', lang: 'ko', label: '외부 1', providerId: 'tts-b', providerName: '엔진 B', paid: true },
  {
    id: 'f1',
    lang: 'ko',
    label: '플래시 1',
    providerId: 'flash',
    providerName: '플래시 TTS',
    instructionsSupported: true,
    modelId: 'gemini-3.8-flash-tts',
  },
];
const actingVoices = voices.map((voice) => (voice.id === 'b1' ? voice : { ...voice, autoActingSupported: true }));
const analysisEngine = { id: 'e1', name: '분석 A', modelId: 'model-a', enabled: true, paid: true } as SpeakerEngine;
const castingEngine = {
  id: 'c1',
  name: '배정 A',
  modelId: 'select-a',
  enabled: true,
  paid: true,
  purpose: 'casting',
} as SpeakerEngine;
const flash: VoiceDesignProvider = { id: 'flash', name: '플래시 TTS', modelId: 'gemini-3.8-flash-tts', paid: true };
const lite: VoiceDesignProvider = { id: 'tts-g', name: 'Lite', modelId: 'gemini-3.8-flash-lite-tts', paid: true };
const estimateValue = { fingerprint: 'fp-r', chapterCount: 2, itemCount: 4, characters: 900, paid: true };
const source = (overrides: Partial<SpeakerRevoiceSource> = {}): SpeakerRevoiceSource => ({
  chapterCount: 2,
  itemCount: 10,
  narratorVoiceId: 'a1',
  voices: [
    { speakerId: 'narrator', name: '내레이터', voiceId: 'a1', itemCount: 6 },
    { speakerId: 's1', name: '인물 1', voiceId: 'a2', instructions: '차분하게', itemCount: 4 },
  ],
  ...overrides,
});
/** Flash narrator; a pinned designed extra, a supporting role and a major role. */
const flashSource = (overrides: Partial<SpeakerRevoiceSource> = {}) =>
  source({
    narratorVoiceId: 'f1',
    voices: [
      { speakerId: 'narrator', name: '내레이터', voiceId: 'f1', itemCount: 6 },
      {
        speakerId: 'x1',
        name: '엑스트라 1',
        voiceId: 'a2',
        itemCount: 1,
        importance: 'extra',
        pinned: true,
        designed: true,
      },
      { speakerId: 's2', name: '조연 1', voiceId: 'a1', itemCount: 2, importance: 'supporting' },
      { speakerId: 's1', name: '주연 1', voiceId: 'a2', itemCount: 9, importance: 'major' },
    ],
    ...overrides,
  });
const job = (overrides: Partial<SpeakerGenerationJob> = {}) =>
  ({ id: 'job-1', status: 'completed', chapterCount: 2, itemCount: 10, ...overrides }) as SpeakerGenerationJob;
function fixture(value = source()) {
  return {
    revoiceSource: vi.fn<NonNullable<SpeakerGenerationPort['revoiceSource']>>(async () => value),
    estimateRevoice: vi.fn<NonNullable<SpeakerGenerationPort['estimateRevoice']>>(async () => estimateValue),
    revoice: vi.fn<NonNullable<SpeakerGenerationPort['revoice']>>(async () =>
      job({ id: 'job-2', revoiceFrom: 'job-1' }),
    ),
    castings: vi.fn(),
    assign: vi.fn(),
  } as unknown as SpeakerGenerationPort &
    Record<'revoiceSource' | 'estimateRevoice' | 'revoice' | 'castings' | 'assign', ReturnType<typeof vi.fn>>;
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll((n) => n.type === 'button' && (n.props['aria-label'] ?? text(n).trim()) === label);
const button = (root: ReactTestInstance, label: string) => {
  const [found] = buttons(root, label);
  if (!found) throw Error('missing button ' + label);
  return found;
};
const byLabel = (root: ReactTestInstance, label: string) =>
  root.findAll((n) => n.props['aria-label'] === label && typeof n.type === 'string');
/** Per-character plan: a radio group of 그대로 / 다른 목소리 / 새로 만들기. */
const plan = (root: ReactTestInstance, name: string, value: 'keep' | 'swap' | 'design') =>
  byLabel(root, `${name} 목소리`)[0]?.findAll((n) => n.type === 'input' && n.props.value === value)[0];
async function choose(root: ReactTestInstance, name: string, value: 'keep' | 'swap' | 'design') {
  const input = plan(root, name, value);
  if (!input) throw Error(`missing ${value} for ${name}`);
  expect(input.props.disabled).not.toBe(true);
  act(() => input.props.onChange());
  await flush();
}
const checkbox = (root: ReactTestInstance, label: string) =>
  root
    .findAll((n) => n.type === 'label' && text(n).includes(label))
    .at(-1)!
    .find((n) => n.type === 'input' && n.props.type === 'checkbox');
async function flush() {
  await act(async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
}
type Props = Partial<Parameters<typeof UiNextSpeakerRevoice>[0]>;
async function mount(port: SpeakerGenerationPort, props: Props = {}) {
  const onCreated = props.onCreated ?? vi.fn();
  act(() => {
    renderer = create(
      <UiNextSpeakerRevoice job={job()} port={port} voices={voices} {...props} onCreated={onCreated} />,
    );
  });
  const open = renderer!.root.findAll((n) => n.type === 'button' && text(n).includes('목소리 바꾸기'))[0];
  if (open) act(() => open.props.onClick());
  await flush();
  return renderer!.root;
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
  await flush();
}
async function change(node: ReactTestInstance, value: string) {
  act(() => node.props.onChange({ target: { value } }));
  await flush();
}
const CHECK = '범위·요금 확인';
const flashProps = (): Props => ({ engines: [analysisEngine, castingEngine], designers: [flash, lite] });

describe('UiNextSpeakerRevoice character plan', () => {
  it('keeps everyone by default, swaps one character and applies it to the book unless turned off', async () => {
    const port = fixture();
    const root = await mount(port);
    expect(port.revoiceSource).toHaveBeenCalledWith('job-1', expect.any(AbortSignal));
    expect(text(root)).toContain('바꿀 인물을 골라 주세요.');
    expect(button(root, CHECK).props.disabled).toBe(true);
    expect(text(byLabel(root, '바뀌는 내용')[0])).toContain('바뀜없음');

    await choose(root, '인물 1', 'swap');
    expect(byLabel(root, '인물 1 새 목소리')[0].props.value).not.toBe('a2');
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    expect(text(root)).toContain('목소리 2목소리 3');
    expect(text(byLabel(root, '바뀌는 내용')[0])).toContain('바뀜1명인물 1');
    expect(text(root)).toContain('이 작품의 인물 목소리도 바뀌어요.');
    await click(button(root, CHECK));
    expect(port.estimateRevoice).toHaveBeenLastCalledWith(
      'job-1',
      {
        applyToBook: true,
        voices: [
          { speakerId: 'narrator', voiceId: 'a1' },
          { speakerId: 's1', voiceId: 'a3', instructions: '차분하게' },
        ],
      },
      expect.any(AbortSignal),
    );

    act(() => checkbox(root, '다음 회차에도 바꾼 목소리 쓰기').props.onChange({ target: { checked: false } }));
    await flush();
    expect(text(root)).toContain('이번 음성에만 적용하고, 작품 목소리는 그대로 둬요.');
    // A changed plan drops the old confirmation.
    expect(byLabel(root, '만들기 확인')).toHaveLength(0);
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1].applyToBook).toBe(false);

    // Re-picking the captured voice is no change at all.
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a2');
    expect(text(root)).toContain('바꿀 인물을 골라 주세요.');
    expect(port.castings).not.toHaveBeenCalled();
    expect(port.assign).not.toHaveBeenCalled();
  });

  it('changes only this audio for the narrator and never claims a book-wide narrator change', async () => {
    const port = fixture();
    const root = await mount(port);
    await choose(root, '내레이터', 'swap');
    await change(byLabel(root, '내레이터 새 목소리')[0], 'b1');
    expect(text(root)).toContain('내레이터는 이번 음성에만 바뀌어요.');
    expect(text(root)).not.toContain('다음 회차에도 바꾼 목소리 쓰기');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('applyToBook');
    expect(port.estimateRevoice.mock.lastCall![1].voices[0]).toEqual({ speakerId: 'narrator', voiceId: 'b1' });
  });

  it('offers new voices only for an exact Gemini 3.8 Flash TTS narrator listed as a designer', async () => {
    // Non-Flash narrator, even with a Flash designer listed.
    let root = await mount(fixture(), flashProps());
    expect(plan(root, '인물 1', 'design')).toBeUndefined();
    expect(text(root)).not.toContain('새로 만들기');
    act(() => renderer!.unmount());
    // Flash-Lite narrator on a listed connection.
    root = await mount(
      fixture(
        source({
          voices: [
            { speakerId: 'narrator', name: '내레이터', voiceId: 'a3', itemCount: 6 },
            ...source().voices.slice(1),
          ],
        }),
      ),
      flashProps(),
    );
    expect(plan(root, '인물 1', 'design')).toBeUndefined();
    act(() => renderer!.unmount());
    // Flash narrator, but the connection is not a listed designer.
    root = await mount(fixture(flashSource()), { engines: [castingEngine], designers: [lite] });
    expect(plan(root, '주연 1', 'design')).toBeUndefined();
    act(() => renderer!.unmount());
    // Flash narrator without a selection model: creation is not offered, and why is said once.
    root = await mount(fixture(flashSource()), { engines: [analysisEngine], designers: [flash] });
    expect(plan(root, '주연 1', 'design')).toBeUndefined();
    expect(text(root)).toContain('배정 AI 모델이 필요해요');
    act(() => renderer!.unmount());
    // Flash narrator: creation for characters, never for the narrator.
    root = await mount(fixture(flashSource()), flashProps());
    expect(plan(root, '주연 1', 'design')).toBeDefined();
    expect(plan(root, '내레이터', 'design')).toBeUndefined();
  });

  it('uses the original narrator when the job has no narrator lines', async () => {
    const lines = flashSource().voices.filter((v) => v.speakerId !== 'narrator');
    let root = await mount(fixture(flashSource({ voices: lines })), flashProps());
    expect(byLabel(root, '내레이터 목소리')).toHaveLength(0);
    expect(plan(root, '주연 1', 'design')).toBeDefined();
    act(() => renderer!.unmount());
    // An older source without the field cannot prove a Flash narrator.
    root = await mount(fixture(flashSource({ voices: lines, narratorVoiceId: undefined })), flashProps());
    expect(plan(root, '주연 1', 'design')).toBeUndefined();
  });

  it('recreates an explicitly chosen pinned designed extra and sends the exact targets and budget', async () => {
    const port = fixture(flashSource());
    port.estimateRevoice.mockResolvedValue({
      ...estimateValue,
      recastCharacters: 2,
      selectionModelLabel: '배정 A',
      maxDesignedVoices: 2,
    });
    const root = await mount(port, flashProps());
    // Narrator first, then major, supporting, extra.
    expect(byLabel(root, '내레이터 목소리')).toHaveLength(1);
    const names = root.findAll((n) => n.props.className === 'un-recast-head').map((n) => n.findByType('b').children[0]);
    expect(names).toEqual(['내레이터', '주연 1', '조연 1', '엑스트라 1']);
    expect(text(root)).toContain('엑스트라직접 지정만든 목소리');

    await choose(root, '엑스트라 1', 'design');
    expect(text(root)).toContain('지금 목소리 대신 본문에 맞춰 새 목소리를 만들어요.');
    await choose(root, '주연 1', 'design');
    await choose(root, '조연 1', 'swap');
    await change(byLabel(root, '조연 1 새 목소리')[0], 'b1');
    expect(byLabel(root, '배정 AI 모델')[0].props.value).toBe('c1');
    expect(text(byLabel(root, '바뀌는 내용')[0])).toContain('3명 · 새로 만들기 2명엑스트라 1, 조연 1, 주연 1');
    expect(text(root)).toContain('새로 만드는 인물은 만들어진 뒤에 반영돼요.');
    await click(button(root, CHECK));
    expect(port.estimateRevoice).toHaveBeenLastCalledWith(
      'job-1',
      {
        designSpeakerIds: ['x1', 's1'],
        casting: {
          engineId: 'c1',
          autoDesign: true,
          designMode: 'characters',
          designProviderId: 'flash',
          designModelId: 'gemini-3.8-flash-tts',
          maxDesignedVoices: 2,
        },
        applyToBook: true,
        voices: [
          { speakerId: 'narrator', voiceId: 'f1' },
          // Targets carry their captured voice; the server replaces it with the new one.
          { speakerId: 'x1', voiceId: 'a2' },
          { speakerId: 's2', voiceId: 'b1' },
          { speakerId: 's1', voiceId: 'a2' },
        ],
      },
      expect.any(AbortSignal),
    );
    const confirm = text(byLabel(root, '만들기 확인')[0]);
    expect(confirm).toContain('새로 만들 인물2');
    expect(confirm).toContain('배정 A');
    expect(confirm).toContain('플래시 TTS');

    // Back to 그대로 drops the target and its casting block.
    await choose(root, '엑스트라 1', 'keep');
    await choose(root, '주연 1', 'keep');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('designSpeakerIds');
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('casting');
  });

  it('judges a design target by the Flash narrator, even when its old voice is gone or cannot act', async () => {
    const port = fixture(
      flashSource({
        hasActing: true,
        needsActing: false,
        voices: [
          { speakerId: 'narrator', name: '내레이터', voiceId: 'f1', itemCount: 6 },
          { speakerId: 's1', name: '주연 1', voiceId: 'deleted-voice', instructions: '낮게', itemCount: 9 },
          { speakerId: 's2', name: '조연 1', voiceId: 'b1', itemCount: 2 },
        ],
      }),
    );
    const root = await mount(port, { ...flashProps(), voices: actingVoices });
    // Kept as is, the gone voice and the non-acting voice both block.
    expect(text(root)).toContain('주연 1의 목소리를 찾을 수 없어요');
    await choose(root, '주연 1', 'design');
    expect(text(root)).toContain('장면 연기를 지원하지 않는 목소리예요: 조연 1');
    await choose(root, '조연 1', 'design');
    expect(text(root)).not.toContain('지원하지 않는 목소리');
    expect(byLabel(root, '주연 1 말투')[0].props.value).toBe('낮게');
    await click(button(root, CHECK));
    const sent = port.estimateRevoice.mock.lastCall![1];
    expect(sent.designSpeakerIds).toEqual(['s1', 's2']);
    expect(sent.voices).toEqual([
      { speakerId: 'narrator', voiceId: 'f1' },
      { speakerId: 's1', voiceId: 'deleted-voice', instructions: '낮게' },
      { speakerId: 's2', voiceId: 'b1' },
    ]);
  });

  it('creates at most eight voices: the bulk pick stops at 8 and a ninth needs a slot', async () => {
    const cast = Array.from({ length: 10 }, (_, i) => ({
      speakerId: `p${i + 1}`,
      name: `인물 ${i + 1}`,
      voiceId: 'a1',
      itemCount: 20 - i,
      importance: i === 9 ? ('extra' as const) : ('supporting' as const),
    }));
    const port = fixture(
      source({
        narratorVoiceId: 'f1',
        voices: [{ speakerId: 'narrator', name: '내레이터', voiceId: 'f1', itemCount: 30 }, ...cast],
      }),
    );
    const root = await mount(port, flashProps());
    await click(button(root, '주요·조연 새로 만들기'));
    // The 8 who speak most among the 9 non-extras.
    for (let i = 1; i <= 8; i++) expect(plan(root, `인물 ${i}`, 'design')!.props.checked).toBe(true);
    expect(plan(root, '인물 9', 'design')!.props.checked).toBe(false);
    expect(plan(root, '인물 9', 'design')!.props.disabled).toBe(true);
    expect(plan(root, '인물 10', 'design')!.props.disabled).toBe(true);
    expect(text(root)).toContain('한 번에 8명까지 새로 만들 수 있어요.');
    await click(button(root, CHECK));
    const sent = port.estimateRevoice.mock.lastCall![1];
    expect(sent.designSpeakerIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    expect(sent.casting?.maxDesignedVoices).toBe(8);

    await choose(root, '인물 3', 'keep');
    expect(text(root)).not.toContain('한 번에 8명까지');
    await choose(root, '인물 10', 'design');
    expect(plan(root, '인물 9', 'design')!.props.disabled).toBe(true);
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1].designSpeakerIds).toEqual([
      'p1',
      'p2',
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
      'p10',
    ]);

    await click(button(root, '모두 그대로'));
    expect(text(root)).toContain('바꿀 인물을 골라 주세요.');
  });

  it('drops a design plan when the narrator moves off Flash instead of sending it', async () => {
    const port = fixture(flashSource());
    const root = await mount(port, flashProps());
    await choose(root, '주연 1', 'design');
    await choose(root, '내레이터', 'swap');
    await change(byLabel(root, '내레이터 새 목소리')[0], 'a1');
    expect(plan(root, '주연 1', 'design')).toBeUndefined();
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('designSpeakerIds');
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('applyToBook');
  });
});

describe('UiNextSpeakerRevoice scene acting', () => {
  it('keeps acting separate: directions are folded per character and dropped for unsupported voices', async () => {
    const port = fixture();
    const root = await mount(port);
    expect(byLabel(root, '내레이터 말투')).toHaveLength(0);
    expect(byLabel(root, '인물 1 말투')[0].props.value).toBe('차분하게');
    await click(button(root, '지친 듯'));
    expect(byLabel(root, '인물 1 말투')[0].props.value).toBe('차분하게, 지친 듯');
    expect(button(root, '지친 듯').props.disabled).toBe(true);
    // A direction-only change is a change; the book assignment is not involved.
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).toEqual({
      voices: [
        { speakerId: 'narrator', voiceId: 'a1' },
        { speakerId: 's1', voiceId: 'a2', instructions: '차분하게, 지친 듯' },
      ],
    });

    await choose(root, '인물 1', 'swap');
    await change(byLabel(root, '인물 1 새 목소리')[0], 'b1');
    expect(byLabel(root, '인물 1 말투')).toHaveLength(0);
    expect(text(root)).toContain('인물 1: 고른 목소리가 말투 지시를 지원하지 않아 지시 없이 만들어요.');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1].voices[1]).toEqual({ speakerId: 's1', voiceId: 'b1' });
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    expect(byLabel(root, '인물 1 말투')[0].props.value).toBe('차분하게, 지친 듯');
  });

  it('adds automatic acting only with an explicit analysis model', async () => {
    const port = fixture(source({ actingEngineId: 'gone' }));
    port.estimateRevoice.mockResolvedValue({ ...estimateValue, actingAnalysis: true });
    const root = await mount(port, { voices: actingVoices, engines: [analysisEngine] });
    expect(byLabel(root, '장면 연기')[1].props.value).toBe('preserve');
    await change(byLabel(root, '장면 연기')[1], 'auto');
    expect(byLabel(root, '연기 분석 모델')[0].props.value).toBe('');
    expect(text(root)).toContain('원래 분석 모델이 없어요');
    expect(button(root, CHECK).props.disabled).toBe(true);
    await change(byLabel(root, '연기 분석 모델')[0], 'e1');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).toEqual({
      acting: { mode: 'auto', engineId: 'e1' },
      voices: [
        { speakerId: 'narrator', voiceId: 'a1' },
        { speakerId: 's1', voiceId: 'a2', instructions: '차분하게' },
      ],
    });
    expect(text(root)).toContain('분석 A · 빠진 부분만');
    await choose(root, '인물 1', 'swap');
    await change(byLabel(root, '인물 1 새 목소리')[0], 'b1');
    expect(text(root)).toContain('장면 연기를 지원하지 않는 목소리예요: 인물 1');
    expect(button(root, CHECK).props.disabled).toBe(true);
  });

  it('fills missing acting by default with the original model, and keeps or removes existing tags', async () => {
    let port = fixture(source({ actingEngineId: 'e1' }));
    let root = await mount(port, { voices: actingVoices, engines: [analysisEngine] });
    expect(byLabel(root, '장면 연기')[1].props.value).toBe('auto');
    expect(byLabel(root, '연기 분석 모델')[0].props.value).toBe('e1');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1].acting).toEqual({ mode: 'auto', engineId: 'e1' });
    await change(byLabel(root, '장면 연기')[1], 'preserve');
    expect(button(root, CHECK).props.disabled).toBe(true);
    act(() => renderer!.unmount());

    port = fixture(
      source({
        hasActing: true,
        needsActing: false,
        voices: [
          { speakerId: 'narrator', name: '내레이터', voiceId: 'a1', itemCount: 6 },
          { speakerId: 's1', name: '인물 1', voiceId: 'a2', itemCount: 4 },
        ],
      }),
    );
    root = await mount(port, { voices: actingVoices });
    const acting = byLabel(root, '장면 연기')[1];
    expect(acting.props.value).toBe('preserve');
    expect(acting.findAll((n) => n.type === 'option' && n.props.value === 'auto')).toHaveLength(0);
    expect(text(root)).toContain('인물별 말투 직접 적기선택');
    await change(byLabel(root, '장면 연기')[1], 'off');
    await click(button(root, CHECK));
    expect(port.estimateRevoice.mock.lastCall![1]).toEqual({
      acting: { mode: 'off' },
      voices: [
        { speakerId: 'narrator', voiceId: 'a1' },
        { speakerId: 's1', voiceId: 'a2' },
      ],
    });
  });
});

describe('UiNextSpeakerRevoice creating', () => {
  it('needs paid consent, creates once per click and reloads the list without resending an unclear failure', async () => {
    const port = fixture();
    const onCreated = vi.fn();
    const root = await mount(port, { onCreated });
    await choose(root, '인물 1', 'swap');
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    await click(button(root, CHECK));
    expect(button(root, '새 음성 만들기').props.disabled).toBe(true);
    act(() => checkbox(root, '유료 API 요금').props.onChange({ target: { checked: true } }));
    await flush();

    port.revoice.mockRejectedValueOnce(new Error('응답 시간 초과'));
    const start = button(root, '새 음성 만들기');
    act(() => {
      start.props.onClick();
      start.props.onClick();
    });
    await flush();
    expect(port.revoice).toHaveBeenCalledTimes(1);
    expect(port.revoice).toHaveBeenCalledWith(
      'job-1',
      {
        applyToBook: true,
        voices: [
          { speakerId: 'narrator', voiceId: 'a1' },
          { speakerId: 's1', voiceId: 'a3', instructions: '차분하게' },
        ],
      },
      'fp-r',
      true,
      expect.any(AbortSignal),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain('응답 시간 초과');
    expect(text(root)).toContain('다시 눌러도 같은 작업이 두 번 생기지 않아요');
    await flush();
    expect(port.revoice).toHaveBeenCalledTimes(1);

    await click(button(root, '새 음성 만들기'));
    expect(port.revoice).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(text(root)).toContain('새 음성을 만들기 시작했어요');

    await change(byLabel(root, '인물 1 말투')[0], '조금 더 느리게');
    await click(button(root, CHECK));
    expect(checkbox(root, '유료 API 요금').props.checked).toBe(false);
  });

  it('cancels a pending estimate or create on close or resume, ignores late replies and keeps the draft', async () => {
    const port = fixture();
    const onCreated = vi.fn();
    const root = await mount(port, { onCreated });
    let release!: (value: unknown) => void;
    port.estimateRevoice.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await choose(root, '인물 1', 'swap');
    await click(button(root, CHECK));
    const estimateSignal: AbortSignal = port.estimateRevoice.mock.calls[0][2];
    await click(button(root, '목소리 바꾸기 닫기'));
    expect(estimateSignal.aborted).toBe(true);
    await act(async () => release({ fingerprint: 'late', chapterCount: 2, itemCount: 4, characters: 900, paid: true }));
    await click(root.find((n) => n.type === 'button' && text(n).includes('목소리 바꾸기')));
    expect(plan(root, '인물 1', 'swap')!.props.checked).toBe(true);
    expect(byLabel(root, '만들기 확인')).toHaveLength(0);

    await click(button(root, CHECK));
    act(() => checkbox(root, '유료 API 요금').props.onChange({ target: { checked: true } }));
    port.revoice.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_, reject) =>
          (args[4] as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    );
    await click(button(root, '새 음성 만들기'));
    const createSignal: AbortSignal = port.revoice.mock.calls[0][4];
    const view = (status: SpeakerGenerationJob['status']) =>
      act(() =>
        renderer!.update(
          <UiNextSpeakerRevoice job={job({ status })} port={port} voices={voices} onCreated={onCreated} />,
        ),
      );
    view('running');
    await flush();
    expect(createSignal.aborted).toBe(true);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(port.revoice).toHaveBeenCalledTimes(1);
    view('paused');
    await flush();
    expect(plan(root, '인물 1', 'swap')!.props.checked).toBe(true);
    expect(byLabel(root, '만들기 확인')).toHaveLength(0);
    expect(button(root, CHECK).props.disabled).not.toBe(true);
  });

  it('states a partial plan and stays hidden for running or empty source jobs', async () => {
    const root = await mount(fixture(source({ chapterCount: 1, itemCount: 4 })), {
      job: job({ status: 'paused', planningComplete: false }),
    });
    expect(text(root)).toContain('분석이 끝난 1개 회차만 바꿔요');
    act(() => renderer!.unmount());
    const running = fixture();
    renderer = create(
      <UiNextSpeakerRevoice job={job({ status: 'running' })} port={running} voices={voices} onCreated={vi.fn()} />,
    );
    expect(renderer.toJSON()).toBeNull();
    act(() =>
      renderer!.update(
        <UiNextSpeakerRevoice job={job({ itemCount: 0 })} port={running} voices={voices} onCreated={vi.fn()} />,
      ),
    );
    expect(renderer.toJSON()).toBeNull();
    expect(running.revoiceSource).not.toHaveBeenCalled();
  });
});
