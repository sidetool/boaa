import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type { LibraryVoice, VoiceLibraryPort } from '../../providers/voice-library';
import UiNextVoiceLibrary from './UiNextVoiceLibrary';

const audio = vi.hoisted(() => ({ stop: vi.fn(), playBlob: vi.fn(async () => true) }));
vi.mock('../../providers/browser-audio-session', () => ({
  BrowserAudioSession: class {
    stop = audio.stop;
    playBlob = audio.playBlob;
  },
}));
const row = (override: Partial<LibraryVoice> = {}): LibraryVoice => ({
  id: 'library-one',
  voiceId: 'local:a',
  providerId: 'local',
  providerVoiceId: 'a',
  model: { providerId: 'local', modelId: 'fixture', revision: 'stable' },
  origin: 'catalog',
  alias: '저장한 별칭',
  timbre: '따뜻함',
  description: '저장한 설명',
  language: 'ko',
  enabled: true,
  available: true,
  sampleAvailable: false,
  createdAt: '2026-10-27T00:00:00.000Z',
  ...override,
});
const voices: PlainTTSVoice[] = [
  { id: 'local:a', label: '목소리 A', description: '또렷한 기본 설명', lang: 'ko', providerId: 'local' },
  { id: 'local:b', label: '목소리 B', description: '부드러운 기본 설명', lang: 'ko', providerId: 'local' },
];
function fixture() {
  let rows = [row()];
  const port = {
    list: vi.fn<VoiceLibraryPort['list']>(async () => ({
      voices: rows,
      designers: [{ id: 'designer', name: '합성 TTS', modelId: 'gemini-3.8-flash-tts', paid: true }],
    })),
    save: vi.fn<VoiceLibraryPort['save']>(async (input, _signal, id) => {
      const value = row({ ...input, id: id ?? 'new-row' });
      rows = [value];
      return value;
    }),
    remove: vi.fn<VoiceLibraryPort['remove']>(async () => {
      rows = [];
    }),
    design: vi.fn<VoiceLibraryPort['design']>(async () => row({ id: 'new-design', origin: 'designed' })),
    sample: vi.fn<VoiceLibraryPort['sample']>(async () => new Blob(['fixture'], { type: 'audio/wav' })),
  } satisfies VoiceLibraryPort;
  return { port, changed: vi.fn() };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const button = (root: ReactTestInstance, label: string) =>
  root.find((n) => n.type === 'button' && (n.props['aria-label'] ?? text(n).trim()) === label);
const field = (root: ReactTestInstance, label: string) => {
  const parent = root
    .findAllByType('label')
    .find((n) => n.children.some((c) => typeof c !== 'string' && c.type === 'span' && text(c) === label));
  if (!parent) throw Error('missing field ' + label);
  return parent.find((n) => ['input', 'select', 'textarea'].includes(String(n.type)));
};
async function flush() {
  await act(async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
}
async function mount(port: VoiceLibraryPort, onChanged = vi.fn()) {
  act(() => {
    renderer = create(<UiNextVoiceLibrary port={port} voices={voices} onChanged={onChanged} />);
  });
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

describe('UiNextVoiceLibrary owned edits and design requests', () => {
  it('saves alias, timbre and description while keeping the selected source voice immutable', async () => {
    const f = fixture();
    const root = await mount(f.port, f.changed);
    await click(button(root, '수정'));
    expect(field(root, '목소리').props.disabled).toBe(true);
    await change(field(root, '별칭'), '수정한 별칭');
    await change(field(root, '음색'), '낮고 부드러움');
    await change(field(root, '설명'), '수정한 설명');
    await click(button(root, '저장'));
    expect(f.port.save).toHaveBeenCalledWith(
      {
        voiceId: 'local:a',
        alias: '수정한 별칭',
        timbre: '낮고 부드러움',
        description: '수정한 설명',
        language: 'ko',
        enabled: true,
      },
      expect.any(AbortSignal),
      'library-one',
    );
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain('수정한 별칭');
  });

  it('prefills catalog alias and traits, follows untouched defaults and preserves user edits', async () => {
    const f = fixture();
    f.port.list.mockResolvedValue({ voices: [], designers: [] });
    const root = await mount(f.port);
    await click(button(root, '기존 목소리 추가'));
    expect(field(root, '별칭').props.value).toBe('목소리 A');
    expect(field(root, '설명').props.value).toBe('또렷한 기본 설명');
    await change(field(root, '목소리'), 'local:b');
    expect(field(root, '별칭').props.value).toBe('목소리 B');
    expect(field(root, '설명').props.value).toBe('부드러운 기본 설명');
    await change(field(root, '별칭'), '직접 고른 별칭');
    await change(field(root, '설명'), '직접 쓴 설명');
    await change(field(root, '목소리'), 'local:a');
    expect(field(root, '별칭').props.value).toBe('직접 고른 별칭');
    expect(field(root, '설명').props.value).toBe('직접 쓴 설명');
  });

  it('never re-adds a saved voice over its labels and labels an unlisted catalog voice as a new row', async () => {
    const f = fixture();
    const root = await mount(f.port);
    expect(text(root)).toContain('보관함에 없는 목록 목소리 1개');
    await click(button(root, '기존 목소리 추가'));
    const select = field(root, '목소리');
    expect(select.props.value).toBe('local:b');
    const savedOption = select.findAllByType('option').find((o) => o.props.value === 'local:a')!;
    expect(savedOption.props.disabled).toBe(true);
    expect(text(savedOption)).toContain('보관함에 있음');
    await click(button(root, '취소'));
    await click(button(root, '목소리 B 라벨 달기'));
    expect(field(root, '목소리').props.value).toBe('local:b');
    expect(text(root)).toContain('local · local:b');
    await click(button(root, '저장'));
    expect(f.port.save).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'local:b', alias: '목소리 B', description: '부드러운 기본 설명' }),
      expect.any(AbortSignal),
      undefined,
    );
  });

  it('toggles timbre quick picks without dropping typed words and shows the saved ID and model', async () => {
    const f = fixture();
    const root = await mount(f.port);
    expect(text(root)).toContain('local · a · fixture');
    await click(button(root, '수정'));
    expect(text(root)).toContain('local · a · fixture');
    await change(field(root, '음색'), '따뜻함、직접 들은 느낌');
    await click(button(root, '낮은'));
    expect(field(root, '음색').props.value).toBe('따뜻함, 직접 들은 느낌, 낮은');
    expect(button(root, '낮은').props['aria-pressed']).toBe(true);
    await click(button(root, '따뜻한'));
    await click(button(root, '낮은'));
    expect(field(root, '음색').props.value).toBe('따뜻함, 직접 들은 느낌, 따뜻한');
    await click(button(root, '저장'));
    expect(f.port.save.mock.calls[0][0].timbre).toBe('따뜻함, 직접 들은 느낌, 따뜻한');
    expect(f.port.save.mock.calls[0][2]).toBe('library-one');
  });

  it('filters by label status and searches language and IDs, keeping the filter after an edit', async () => {
    const f = fixture();
    const rows = [
      row(),
      row({ id: 'blank', voiceId: 'local:b', providerVoiceId: 'b', alias: '빈 라벨', timbre: '', description: '' }),
      row({
        id: 'off',
        voiceId: 'remote:c',
        providerVoiceId: 'zephyr',
        alias: '꺼둔 목소리',
        enabled: false,
        language: 'ja',
      }),
    ];
    f.port.list.mockResolvedValue({ voices: rows, designers: [] });
    const root = await mount(f.port);
    const chip = (label: string) =>
      root.find((n) => n.type === 'button' && n.props['aria-pressed'] !== undefined && text(n).startsWith(label));
    const aliases = () => root.findAllByType('b').map(text);
    expect(text(chip('라벨 필요'))).toBe('라벨 필요 1');
    await click(chip('라벨 필요'));
    expect(aliases()).toEqual(['빈 라벨']);
    await click(chip('자동 배정 꺼짐'));
    expect(aliases()).toEqual(['꺼둔 목소리']);
    await click(chip('전체'));
    await change(field(root, '목소리 찾기'), 'ZEPHYR');
    expect(aliases()).toEqual(['꺼둔 목소리']);
    await change(field(root, '목소리 찾기'), 'ja');
    expect(aliases()).toEqual(['꺼둔 목소리']);
    await change(field(root, '목소리 찾기'), '');
    await click(chip('라벨 필요'));
    await click(button(root, '수정'));
    await click(button(root, '저장'));
    expect(chip('라벨 필요').props['aria-pressed']).toBe(true);
  });

  it('offers voice design only through Gemini 3.8 Flash TTS and shows its fixed model with guidance', async () => {
    const f = fixture();
    f.port.list.mockResolvedValue({
      voices: [],
      designers: [{ id: 'lite', name: 'Lite TTS', modelId: 'gemini-3.8-flash-lite-tts', paid: true }],
    });
    let root = await mount(f.port);
    expect(root.findAll((n) => n.type === 'button' && text(n).trim() === '설명으로 만들기')).toHaveLength(0);
    act(() => renderer!.unmount());
    renderer = undefined;
    f.port.list.mockResolvedValue({
      voices: [],
      designers: [{ id: 'designer', name: '합성 TTS', modelId: 'gemini-3.8-flash-tts', paid: true }],
    });
    root = await mount(f.port);
    await click(button(root, '설명으로 만들기'));
    expect(text(root)).toContain('Gemini 3.8: 성별·나이대');
    expect(text(root)).toContain('제작 모델 gemini-3.8-flash-tts');
    // The model is not typed: any other id would be rejected for voice design.
    expect(root.findAll((n) => n.type === 'input' && n.props.value === 'gemini-3.8-flash-tts')).toHaveLength(0);
  });

  it('requires paid opt-in, suppresses a double click, reuses the request ID on retry and renews it after edits', async () => {
    const f = fixture();
    const root = await mount(f.port);
    f.port.design.mockRejectedValue(new Error('429 synthetic retry'));
    await click(button(root, '설명으로 만들기'));
    await change(field(root, '별칭'), '새 별칭');
    await change(field(root, '만들 목소리 설명'), '차분한 원래 목소리');
    expect(button(root, '만들어 보관하기').props.disabled).toBe(true);
    act(() =>
      field(root, '새 목소리를 만드는 API 사용 요금을 확인했어요.').props.onChange({ target: { checked: true } }),
    );
    await flush();
    const start = button(root, '만들어 보관하기');
    act(() => {
      start.props.onClick();
      start.props.onClick();
    });
    await flush();
    expect(f.port.design).toHaveBeenCalledTimes(1);
    const original = f.port.design.mock.calls[0][0];
    expect(original).toMatchObject({
      providerId: 'designer',
      modelId: 'gemini-3.8-flash-tts',
      confirmPaid: true,
      alias: '새 별칭',
      prompt: '차분한 원래 목소리',
    });
    expect(original.requestId).toMatch(/^[a-f\d-]{36}$/i);
    await click(button(root, '만들어 보관하기'));
    expect(f.port.design.mock.calls[1][0].requestId).toBe(original.requestId);
    await change(field(root, '만들 목소리 설명'), '다른 원래 목소리');
    expect(button(root, '만들어 보관하기').props.disabled).toBe(true);
    act(() =>
      field(root, '새 목소리를 만드는 API 사용 요금을 확인했어요.').props.onChange({ target: { checked: true } }),
    );
    await flush();
    await click(button(root, '만들어 보관하기'));
    expect(f.port.design.mock.calls[2][0].requestId).not.toBe(original.requestId);
  });

  it('aborts an old port lifetime and ignores its late list instead of replacing another account rows', async () => {
    const first = fixture(),
      next = fixture();
    let resolve!: (value: Awaited<ReturnType<VoiceLibraryPort['list']>>) => void;
    first.port.list.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await mount(first.port);
    const oldSignal = first.port.list.mock.calls[0][0]!;
    next.port.list.mockResolvedValue({ voices: [row({ id: 'other-row', alias: '다른 계정' })], designers: [] });
    act(() => renderer!.update(<UiNextVoiceLibrary port={next.port} voices={voices} onChanged={next.changed} />));
    await flush();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolve({ voices: [row({ alias: '오래된 결과' })], designers: [] }));
    await flush();
    expect(text(renderer!.root)).toContain('다른 계정');
    expect(text(renderer!.root)).not.toContain('오래된 결과');
  });

  it('aborts a pending sample and stops its audio session on unmount without late playback', async () => {
    const f = fixture();
    let release!: (blob: Blob) => void;
    f.port.sample.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const root = await mount(f.port);
    await click(button(root, '미리듣기'));
    const sampleSignal = f.port.sample.mock.calls[0][1]!;
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(sampleSignal.aborted).toBe(true);
    expect(audio.stop).toHaveBeenCalled();
    await act(async () => release(new Blob(['fixture'])));
    await flush();
    expect(audio.playBlob).not.toHaveBeenCalled();
  });
});
