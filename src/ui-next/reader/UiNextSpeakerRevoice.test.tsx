import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type {
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerRevoiceSource,
} from '../../providers/speaker-generation';
import type { SpeakerEngine } from '../../providers/speaker-engine';
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
];
const actingVoices = voices.map((voice) => (voice.id === 'b1' ? voice : { ...voice, autoActingSupported: true }));
const analysisEngine = { id: 'e1', name: '분석 A', modelId: 'model-a', enabled: true, paid: true } as SpeakerEngine;
const estimateValue = { fingerprint: 'fp-r', chapterCount: 2, itemCount: 4, characters: 900, paid: true };
const source = (overrides: Partial<SpeakerRevoiceSource> = {}): SpeakerRevoiceSource => ({
  chapterCount: 2,
  itemCount: 10,
  voices: [
    { speakerId: 'narrator', name: '내레이터', voiceId: 'a1', itemCount: 6 },
    { speakerId: 's1', name: '인물 1', voiceId: 'a2', instructions: '차분하게', itemCount: 4 },
  ],
  ...overrides,
});
const job = (overrides: Partial<SpeakerGenerationJob> = {}) =>
  ({ id: 'job-1', status: 'completed', chapterCount: 2, itemCount: 10, ...overrides }) as SpeakerGenerationJob;
function fixture(value = source()) {
  return {
    revoiceSource: vi.fn<NonNullable<SpeakerGenerationPort['revoiceSource']>>(async () => value),
    estimateRevoice: vi.fn<NonNullable<SpeakerGenerationPort['estimateRevoice']>>(async () => ({
      fingerprint: 'fp-r',
      chapterCount: 2,
      itemCount: 4,
      characters: 900,
      paid: true,
    })),
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
const button = (root: ReactTestInstance, label: string) =>
  root.find((n) => n.type === 'button' && text(n).trim() === label);
const byLabel = (root: ReactTestInstance, label: string) =>
  root.findAll((n) => n.props['aria-label'] === label && typeof n.type === 'string');
async function flush() {
  await act(async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
}
async function mount(port: SpeakerGenerationPort, item = job(), onCreated = vi.fn()) {
  act(() => {
    renderer = create(<UiNextSpeakerRevoice job={item} port={port} voices={voices} onCreated={onCreated} />);
  });
  const details = renderer!.root.findAllByType('details')[0];
  if (details) act(() => details.props.onToggle({ currentTarget: { open: true } }));
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

describe('UiNextSpeakerRevoice audio-only variant', () => {
  it('edits the captured voices, shows acting directions only where supported and keeps typed directions', async () => {
    const port = fixture();
    const root = await mount(port);
    expect(port.revoiceSource).toHaveBeenCalledWith('job-1', expect.any(AbortSignal));
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
    expect(byLabel(root, '내레이터 연기 지시')).toHaveLength(0);
    expect(byLabel(root, '인물 1 연기 지시')[0].props.value).toBe('차분하게');

    await change(byLabel(root, '인물 1 새 목소리')[0], 'b1');
    expect(byLabel(root, '인물 1 연기 지시')).toHaveLength(0);
    expect(text(root)).toContain('연기 지시를 지원하지 않아 지시 없이 만들어요');
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice).toHaveBeenLastCalledWith(
      'job-1',
      {
        voices: [
          { speakerId: 'narrator', voiceId: 'a1' },
          { speakerId: 's1', voiceId: 'b1' },
        ],
      },
      expect.any(AbortSignal),
    );

    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    expect(byLabel(root, '인물 1 연기 지시')[0].props.value).toBe('차분하게');
    expect(root.findAll((n) => n.type === 'button' && text(n).trim() === '새 음성 만들기')).toHaveLength(0);
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice.mock.calls.at(-1)![1].voices[1]).toEqual({
      speakerId: 's1',
      voiceId: 'a3',
      instructions: '차분하게',
    });
    expect(port.castings).not.toHaveBeenCalled();
    expect(port.assign).not.toHaveBeenCalled();
  });

  it('appends optional acting examples and shows Gemini 3.8 guidance only for that model', async () => {
    const root = await mount(fixture());
    expect(text(root)).not.toContain('Gemini 3.8');
    await click(button(root, '지친 듯'));
    expect(byLabel(root, '인물 1 연기 지시')[0].props.value).toBe('차분하게, 지친 듯');
    expect(button(root, '지친 듯').props.disabled).toBe(true);
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    expect(text(root)).toContain('Gemini 3.8: 이 인물의 대사를');
    expect(byLabel(root, '내레이터 연기 예시')).toHaveLength(0);
  });

  it('adds automatic acting only with an explicit analysis model and explains its extra cost', async () => {
    const port = fixture(source({ actingEngineId: 'gone' }));
    port.estimateRevoice.mockResolvedValue({ ...estimateValue, actingAnalysis: true });
    act(() => {
      renderer = create(
        <UiNextSpeakerRevoice
          job={job()}
          port={port}
          voices={actingVoices}
          engines={[analysisEngine]}
          onCreated={vi.fn()}
        />,
      );
    });
    act(() => renderer!.root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
    await flush();
    const root = renderer!.root;
    expect(byLabel(root, '자동 연기')[0].props.value).toBe('preserve');
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
    await change(byLabel(root, '자동 연기')[0], 'auto');
    expect(byLabel(root, '연기 분석 모델')[0].props.value).toBe('');
    expect(text(root)).toContain('원래 분석 모델을 찾을 수 없어요');
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
    await change(byLabel(root, '연기 분석 모델')[0], 'e1');
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice).toHaveBeenLastCalledWith(
      'job-1',
      {
        acting: { mode: 'auto', engineId: 'e1' },
        voices: [
          { speakerId: 'narrator', voiceId: 'a1' },
          { speakerId: 's1', voiceId: 'a2', instructions: '차분하게' },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(text(root)).toContain('연기 분석 모델의 API 사용 요금');
    await change(byLabel(root, '인물 1 새 목소리')[0], 'b1');
    expect(text(root)).toContain('자동 연기를 지원하지 않는 목소리가 있어요 (인물 1)');
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
  });

  it('fills acting by default for an untagged capable source with its model, and needs no model when nothing is missing', async () => {
    const port = fixture(source({ actingEngineId: 'e1' }));
    const open = async (onPort: SpeakerGenerationPort) => {
      act(() => {
        renderer = create(
          <UiNextSpeakerRevoice
            job={job()}
            port={onPort}
            voices={actingVoices}
            engines={[analysisEngine]}
            onCreated={vi.fn()}
          />,
        );
      });
      act(() => renderer!.root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
      await flush();
      return renderer!.root;
    };
    let root = await open(port);
    expect(byLabel(root, '자동 연기')[0].props.value).toBe('auto');
    expect(byLabel(root, '연기 분석 모델')[0].props.value).toBe('e1');
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice.mock.lastCall![1].acting).toEqual({ mode: 'auto', engineId: 'e1' });
    // Without acting and without voice changes there is nothing to re-make.
    await change(byLabel(root, '자동 연기')[0], 'preserve');
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
    await change(byLabel(root, '인물 1 새 목소리')[0], 'a3');
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice.mock.lastCall![1]).not.toHaveProperty('acting');

    act(() => renderer!.unmount());
    const tagged = fixture(source({ hasActing: true, needsActing: false }));
    root = await open(tagged);
    expect(byLabel(root, '자동 연기')[0].props.value).toBe('preserve');
    expect(byLabel(root, '자동 연기')[0].findAll((n) => n.type === 'option' && n.props.value === 'auto')).toHaveLength(
      0,
    );
    await change(byLabel(root, '자동 연기')[0], 'auto');
    expect(byLabel(root, '연기 분석 모델')).toHaveLength(0);
    expect(text(root)).toContain('분석 모델을 부르지 않아요');
    await click(button(root, '다시 만들 범위 확인'));
    expect(tagged.estimateRevoice.mock.lastCall![1].acting).toEqual({ mode: 'auto' });
  });

  it('keeps existing acting tags by default, can remove them, and folds manual directions until asked', async () => {
    const port = fixture(
      source({
        hasActing: true,
        voices: [
          { speakerId: 'narrator', name: '내레이터', voiceId: 'a1', itemCount: 6 },
          { speakerId: 's1', name: '인물 1', voiceId: 'a2', itemCount: 4 },
        ],
      }),
    );
    act(() => {
      renderer = create(<UiNextSpeakerRevoice job={job()} port={port} voices={actingVoices} onCreated={vi.fn()} />);
    });
    act(() => renderer!.root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
    await flush();
    const root = renderer!.root;
    expect(byLabel(root, '인물 1 연기 지시')).toHaveLength(0);
    await click(button(root, '직접 연기 지시 추가'));
    await change(byLabel(root, '인물 1 연기 지시')[0], '조용히');
    await change(byLabel(root, '인물 1 연기 지시')[0], '');
    expect(byLabel(root, '인물 1 연기 지시')).toHaveLength(1);
    expect(button(root, '다시 만들 범위 확인').props.disabled).toBe(true);
    await change(byLabel(root, '자동 연기')[0], 'off');
    await click(button(root, '다시 만들 범위 확인'));
    expect(port.estimateRevoice.mock.lastCall![1]).toEqual({
      acting: { mode: 'off' },
      voices: [
        { speakerId: 'narrator', voiceId: 'a1' },
        { speakerId: 's1', voiceId: 'a2' },
      ],
    });
  });

  it('needs paid consent, creates once per click and reloads the list without resending an unclear failure', async () => {
    const port = fixture();
    const onCreated = vi.fn();
    const root = await mount(port, job(), onCreated);
    await change(byLabel(root, '인물 1 연기 지시')[0], '단호하게');
    await click(button(root, '다시 만들 범위 확인'));
    expect(button(root, '새 음성 만들기').props.disabled).toBe(true);
    const ack = root.find((n) => n.type === 'input' && n.props.type === 'checkbox');
    act(() => ack.props.onChange({ target: { checked: true } }));
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
        voices: [
          { speakerId: 'narrator', voiceId: 'a1' },
          { speakerId: 's1', voiceId: 'a2', instructions: '단호하게' },
        ],
      },
      'fp-r',
      true,
      expect.any(AbortSignal),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain('응답 시간 초과');
    await flush();
    expect(port.revoice).toHaveBeenCalledTimes(1);

    await click(button(root, '새 음성 만들기'));
    expect(port.revoice).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(text(root)).toContain('새 음성 작업을 만들었어요');

    await change(byLabel(root, '인물 1 연기 지시')[0], '조금 더 느리게');
    await click(button(root, '다시 만들 범위 확인'));
    expect(root.find((n) => n.type === 'input' && n.props.type === 'checkbox').props.checked).toBe(false);
  });

  it('cancels a pending estimate or create on close or resume, ignores late replies and keeps the draft', async () => {
    const port = fixture();
    const onCreated = vi.fn();
    const root = await mount(port, job(), onCreated);
    const toggle = async (open: boolean) => {
      act(() => root.findByType('details').props.onToggle({ currentTarget: { open } }));
      await flush();
    };
    let release!: (value: unknown) => void;
    port.estimateRevoice.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await change(byLabel(root, '인물 1 연기 지시')[0], '단호하게');
    await click(button(root, '다시 만들 범위 확인'));
    const estimateSignal: AbortSignal = port.estimateRevoice.mock.calls[0][2];
    await toggle(false);
    expect(estimateSignal.aborted).toBe(true);
    await act(async () => release({ fingerprint: 'late', chapterCount: 2, itemCount: 4, characters: 900, paid: true }));
    await toggle(true);
    expect(byLabel(root, '인물 1 연기 지시')[0].props.value).toBe('단호하게');
    expect(byLabel(root, '다시 만들기 확인')).toHaveLength(0);

    await click(button(root, '다시 만들 범위 확인'));
    act(() =>
      root.find((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }),
    );
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
    expect(byLabel(root, '인물 1 연기 지시')[0].props.value).toBe('단호하게');
    expect(byLabel(root, '다시 만들기 확인')).toHaveLength(0);
    expect(button(root, '다시 만들 범위 확인').props.disabled).not.toBe(true);
  });

  it('states a partial plan and stays hidden for running or empty source jobs', async () => {
    const root = await mount(
      fixture(source({ chapterCount: 1, itemCount: 4 })),
      job({ status: 'paused', planningComplete: false }),
    );
    expect(text(root)).toContain('계획이 끝난 1개 회차·4개 구간만 다시 만들어요');
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
