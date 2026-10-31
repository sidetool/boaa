import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlainTTSVoices } from '../../providers/plain-tts';
import type { SpeakerEngine, SpeakerEnginesPort } from '../../providers/speaker-engine';
import type {
  SpeakerGenerationEstimate,
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerGenerationPreferences,
  TTSSpeakerGenerationControls,
} from '../../providers/speaker-generation';
import UiNextSpeakerGenerationPanel from './UiNextSpeakerGenerationPanel';
import type { LibraryVoice, VoiceLibraryPort } from '../../providers/voice-library';

// The node test environment has no window; the panel's poll timer uses window.setTimeout as in the browser.
if (typeof window === 'undefined') vi.stubGlobal('window', globalThis);

// Neutral synthetic fixtures only.
const chapters = [
  { id: 'c1', title: '1화' },
  { id: 'c2', title: '2화' },
  { id: 'c3', title: '3화' },
];
const engine = (overrides: Partial<SpeakerEngine> = {}): SpeakerEngine => ({
  id: 'e1',
  name: '분석 A',
  engineUrl: 'http://speaker-engine:8095',
  protocol: 'openai',
  url: 'http://10.0.0.2:11434/v1',
  modelId: 'model-a',
  maxOutputTokens: 24576,
  paid: false,
  enabled: true,
  hasApiKey: false,
  hasEngineToken: false,
  revision: 'r1',
  ...overrides,
});
const catalog = (overrides: Partial<PlainTTSVoices> = {}): PlainTTSVoices => ({
  available: true,
  defaultVoiceId: 'a1',
  voices: [
    { id: 'a1', lang: 'ko-KR', label: '목소리 1', providerId: 'tts-a', providerName: '엔진 A' },
    { id: 'a2', lang: 'ko-KR', label: '목소리 2', providerId: 'tts-a', providerName: '엔진 A' },
    { id: 'a3', lang: 'ko-KR', label: '목소리 3', providerId: 'tts-a', providerName: '엔진 A' },
    { id: 'b1', lang: 'ko-KR', label: '외부 1', providerId: 'tts-b', providerName: '엔진 B', paid: true },
  ],
  providers: [
    { id: 'tts-a', name: '엔진 A', available: true },
    { id: 'tts-b', name: '엔진 B', available: true },
  ] as PlainTTSVoices['providers'],
  ...overrides,
});
const estimate = (overrides: Partial<SpeakerGenerationEstimate> = {}): SpeakerGenerationEstimate => ({
  fingerprint: 'fp-1',
  chapterCount: 1,
  contextChapterCount: 1,
  characters: 1800,
  modelLabel: '분석 A · model-a',
  voiceLabel: '목소리 1 외 2개',
  paid: false,
  ...overrides,
});
const job = (overrides: Partial<SpeakerGenerationJob> = {}): SpeakerGenerationJob => ({
  fingerprint: 'fp-1',
  chapterCount: 2,
  itemCount: 10,
  characters: 3600,
  voiceLabel: '목소리 1',
  providerName: '엔진 A',
  paid: false,
  firstChapterTitle: '2화',
  lastChapterTitle: '3화',
  id: 'job-1',
  bookId: 'novel-1',
  title: '합성 작품',
  status: 'running',
  completedItems: 4,
  bytes: 1024,
  playbackIndex: 0,
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
  stage: 'audio',
  analyzedChapters: 3,
  contextChapterCount: 1,
  readyChapterIds: ['c2'],
  ...overrides,
});

function port(
  list: () => Promise<SpeakerGenerationJob[]> = async () => [],
  overrides: Partial<SpeakerGenerationPort> = {},
) {
  return {
    preferences: vi.fn(async (): Promise<SpeakerGenerationPreferences | undefined> => undefined),
    savePreferences: vi.fn(async (_value: SpeakerGenerationPreferences) => undefined),
    list: vi.fn(list),
    estimate: vi.fn(async () => estimate()),
    create: vi.fn(async () => job({ status: 'queued', stage: 'waiting', completedItems: 0, readyChapterIds: [] })),
    control: vi.fn(async (id: string, action: 'pause' | 'resume') =>
      job({ id, status: action === 'pause' ? 'paused' : 'queued' }),
    ),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } satisfies SpeakerGenerationPort;
}
function engines(list: () => Promise<SpeakerEngine[]> = async () => [engine()]) {
  return {
    list: vi.fn(list),
    probe: vi.fn(async () => ({ engineVersion: '1', models: [] })),
    save: vi.fn(async () => engine()),
    remove: vi.fn(async () => undefined),
  } satisfies SpeakerEnginesPort;
}
function controls(overrides: Partial<TTSSpeakerGenerationControls> = {}): TTSSpeakerGenerationControls {
  return {
    key: 'account-1:novel-1',
    port: port(),
    engines: engines(),
    chapters,
    currentChapterId: 'c2',
    voices: catalog(),
    narratorVoiceId: 'a1',
    rules: [],
    footnotePlayback: 'skip',
    listen: vi.fn(),
    refreshVoices: vi.fn(),
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}
async function mount(
  props: TTSSpeakerGenerationControls,
  extra: { onManageEngines?: () => void; onManageVoices?: () => void } = {},
) {
  act(() => {
    renderer = create(<UiNextSpeakerGenerationPanel controls={props} {...extra} />);
  });
  await flush();
  return renderer!.root;
}

function libraryVoice(voiceId: string, enabled = true): LibraryVoice {
  return {
    id: 'library-' + voiceId,
    voiceId,
    providerId: 'tts-a',
    providerVoiceId: voiceId,
    model: { providerId: 'tts-a', revision: 'stable' },
    origin: 'catalog',
    alias: '보관함 ' + voiceId,
    timbre: '따뜻함',
    description: '합성 설명',
    language: 'ko',
    enabled,
    sampleAvailable: false,
    available: true,
    createdAt: '2026-10-27T00:00:00.000Z',
  };
}
function libraryPort(voices: LibraryVoice[] = []): VoiceLibraryPort {
  return {
    list: vi.fn(async () => ({
      voices,
      designers: [{ id: 'designer', name: '제작 TTS', modelId: 'gemini-3.8-flash-tts', paid: true }],
    })),
    save: vi.fn(async () => libraryVoice('a3')),
    remove: vi.fn(async () => {}),
    design: vi.fn(async () => libraryVoice('a3')),
    sample: vi.fn(async () => new Blob()),
  };
}
/** A Gemini 3.8 Flash TTS connection whose id is also its voice design connection. */
const flashCatalog = (modelId = 'gemini-3.8-flash-tts') => {
  const base = catalog();
  return catalog({
    voices: [
      ...base.voices,
      { id: 'g1', lang: 'ko-KR', label: '플래시 1', providerId: 'designer', providerName: '제작 TTS', modelId },
      { id: 'g2', lang: 'ko-KR', label: '플래시 2', providerId: 'designer', providerName: '제작 TTS', modelId },
    ],
    providers: [...(base.providers ?? []), { id: 'designer', name: '제작 TTS', available: true, paid: true }],
  });
};
const hasMode = (root: ReactTestInstance, value: string) =>
  root
    .find((n) => n.props.role === 'radiogroup' && n.props['aria-label'] === '배정 방식')
    .findAll((n) => n.type === 'input' && n.props.value === value).length > 0;
/** The casting mode is a radio card group; each card is a native radio input. */
function modeCard(root: ReactTestInstance, value: string) {
  const group = root.find((n) => n.props.role === 'radiogroup' && n.props['aria-label'] === '배정 방식');
  return group.find((n) => n.type === 'input' && n.props.value === value);
}
const mode = (root: ReactTestInstance) =>
  root
    .find((n) => n.props.role === 'radiogroup' && n.props['aria-label'] === '배정 방식')
    .find((n) => n.type === 'input' && n.props.checked).props.value;
async function chooseMode(root: ReactTestInstance, value: string) {
  const card = modeCard(root, value);
  expect(card.props.disabled).not.toBe(true);
  act(() => card.props.onChange());
  await flush();
}
function castingField(root: ReactTestInstance, label: string) {
  const parent = root
    .findAllByType('label')
    .find((n) => n.children.some((c) => typeof c !== 'string' && c.type === 'span' && text(c).startsWith(label)));
  if (!parent) throw Error('missing casting field ' + label);
  return parent.find((n) => ['input', 'select'].includes(String(n.type)));
}

describe('voice library casting choices', () => {
  it('defaults the pool to enabled curated voices and keeps a one-voice local narrator usable', async () => {
    const api = port();
    let root = await mount(
      controls({ port: api, voiceLibrary: libraryPort([libraryVoice('a2', false), libraryVoice('a3')]) }),
    );
    expect(button(root, /^목소리 3/).props['aria-pressed']).toBe(true);
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(false);
    expect(api.savePreferences).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
    renderer = undefined;
    root = await mount(
      controls({ port: port(), voiceLibrary: libraryPort(), voices: catalog({ voices: [catalog().voices[0]] }) }),
    );
    expect(button(root, /^목소리 1/).props['aria-pressed']).toBe(true);
    expect(button(root, '생성 전 확인').props.disabled).toBe(false);
  });

  it('lists picking candidates by description and never offers voice creation for a non-Flash narrator', async () => {
    const api = port();
    const root = await mount(
      controls({
        port: api,
        voiceLibrary: libraryPort([{ ...libraryVoice('a2'), timbre: '', description: '' }, libraryVoice('a3')]),
        engines: engines(async () => [
          engine({ purpose: 'analysis' }),
          engine({ id: 'casting-model', purpose: 'casting', name: '선정 모델', modelId: 'casting-model-id' }),
        ]),
      }),
    );
    expect(text(select(root, '분석 모델'))).not.toContain('선정 모델');
    expect(mode(root)).toBe('order');
    expect(text(root)).toContain('배정할 목소리');
    // The library lists a Flash designer, but the narrator reads on another connection.
    expect(hasMode(root, 'create')).toBe(false);
    expect(text(root)).not.toContain('Gemini 3.8 Flash');
    await chooseMode(root, 'pick');
    expect(castingField(root, '배정 AI 모델').props.value).toBe('casting-model');
    expect(text(castingField(root, '배정 AI 모델'))).not.toContain('분석 A');
    expect(text(root)).toContain('후보 목소리');
    // Library voice a3 is described; a2 is saved without labels and has no provider description.
    expect(text(root)).toContain('설명 없는 목소리 1개');
    expect(hasMode(root, 'create')).toBe(false);
  });

  it('creates voices on the Flash narrator connection, keeps the limit across reopen and sends it', async () => {
    const api = port();
    vi.mocked(api.estimate).mockResolvedValue(
      estimate({ paid: true, maxDesignedVoices: 3, selectionModelLabel: '선정' }),
    );
    const props = controls({
      port: api,
      voices: flashCatalog(),
      narratorVoiceId: 'g1',
      voiceLibrary: libraryPort(),
      engines: engines(async () => [
        engine({ purpose: 'analysis' }),
        engine({ id: 'casting-model', purpose: 'casting', name: '선정 모델', modelId: 'casting-model-id' }),
      ]),
    });
    let root = await mount(props);
    expect(text(root)).toContain('Gemini 3.8 Flash TTS라 인물마다 새 목소리를 만들 수 있어요.');
    await chooseMode(root, 'create');
    expect(text(root)).toContain('그 밖의 인물용 목소리');
    expect(text(root)).toContain('새 목소리 · 최대 4명');
    expect(text(root)).toContain('제작 TTS에서 만들고');
    // No connection or model to pick: the narrator's connection decides both.
    expect(root.findAll((n) => n.props['aria-label'] === '목소리 제작 연결')).toHaveLength(0);
    await click(button(root, '줄이기'));
    expect(text(root)).toContain('새 목소리 · 최대 3명');
    const casting = {
      engineId: 'casting-model',
      autoDesign: true,
      designMode: 'characters',
      maxDesignedVoices: 3,
      designProviderId: 'designer',
      designModelId: 'gemini-3.8-flash-tts',
    };
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ casting }));
    act(() => renderer!.unmount());
    renderer = undefined;
    root = await mount(props);
    expect(mode(root)).toBe('create');
    expect(castingField(root, '배정 AI 모델').props.value).toBe('casting-model');
    await click(button(root, '생성 전 확인'));
    expect(api.estimate).toHaveBeenCalledWith(expect.objectContaining({ casting }), expect.any(AbortSignal));
    expect(text(root)).toContain('제작 TTS · 최대 3명');
    expect(text(root)).toContain('직접 지정한 인물은 그대로예요.');
    expect(button(root, '생성 시작').props.disabled).toBe(true);
    act(() =>
      castingField(root, '유료 API 요금이 나올 수 있어요').props.onChange({
        target: { checked: true },
      }),
    );
    await flush();
    await click(button(root, '생성 시작'));
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ casting }),
      'fp-1',
      true,
      expect.any(AbortSignal),
    );
  });

  it('sends a usable design limit when switching to creation and asks for one instead of sending a saved 0', async () => {
    const saved = (casting: SpeakerGenerationPreferences['casting']) =>
      port(async () => [], {
        preferences: vi.fn(async () => ({ engineId: 'e1', narratorVoiceId: 'g1', characterVoiceIds: ['g2'], casting })),
      });
    const twoEngines = () =>
      engines(async () => [engine(), engine({ id: 'cast', purpose: 'casting', name: '선정용' })]);
    const flash = { voices: flashCatalog(), voiceLibrary: libraryPort(), engines: twoEngines() };
    // Without design a 0 limit is a valid saved choice; reading it changes nothing.
    let api = saved({ engineId: 'cast', autoDesign: false, maxDesignedVoices: 0 });
    let root = await mount(controls({ port: api, ...flash }));
    expect(mode(root)).toBe('pick');
    expect(api.savePreferences).not.toHaveBeenCalled();
    await chooseMode(root, 'create');
    expect(vi.mocked(api.savePreferences).mock.lastCall![0].casting?.maxDesignedVoices).toBe(4);
    expect(text(root)).toContain('새 목소리 · 최대 4명');
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0].casting?.maxDesignedVoices).toBe(4);
    act(() => renderer!.unmount());

    // A restored creation choice holding 0 is shown as unset and never estimated as is.
    api = saved({
      engineId: 'cast',
      autoDesign: true,
      designMode: 'characters',
      designProviderId: 'designer',
      designModelId: 'gemini-3.8-flash-tts',
      maxDesignedVoices: 0,
    });
    root = await mount(controls({ port: api, ...flash, engines: twoEngines() }));
    expect(mode(root)).toBe('create');
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(text(root)).toContain('인원을 정해 주세요');
    expect(text(root)).toContain('새로 만들 인물 수를 정해 주세요.');
    expect(button(root, '줄이기').props.disabled).toBe(true);
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
    await click(button(root, '늘리기'));
    expect(vi.mocked(api.savePreferences).mock.lastCall![0].casting?.maxDesignedVoices).toBe(1);
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0].casting?.maxDesignedVoices).toBe(1);
  });

  it('opens creation only for an exact Gemini 3.8 Flash TTS narrator and follows it instead of a saved connection', async () => {
    const twoEngines = () =>
      engines(async () => [engine(), engine({ id: 'cast', purpose: 'casting', name: '선정용' })]);
    // Flash-Lite narrator on a listed designer id: no creation.
    let root = await mount(
      controls({
        voices: flashCatalog('gemini-3.8-flash-lite-tts'),
        narratorVoiceId: 'g1',
        voiceLibrary: libraryPort(),
        engines: twoEngines(),
      }),
    );
    expect(hasMode(root, 'create')).toBe(false);
    act(() => renderer!.unmount());
    // Exact Flash model on a connection the library does not list as a designer: no creation.
    root = await mount(
      controls({
        voices: flashCatalog(),
        narratorVoiceId: 'g1',
        voiceLibrary: { ...libraryPort(), list: vi.fn(async () => ({ voices: [], designers: [] })) },
        engines: twoEngines(),
      }),
    );
    expect(hasMode(root, 'create')).toBe(false);
    act(() => renderer!.unmount());

    // A saved creation choice under a non-Flash narrator stays visible, blocks, and is never swapped silently.
    const api = port(async () => [], {
      preferences: vi.fn(async () => ({
        engineId: 'e1',
        narratorVoiceId: 'a1',
        characterVoiceIds: ['a2'],
        casting: {
          engineId: 'cast',
          autoDesign: true,
          designMode: 'characters' as const,
          maxDesignedVoices: 2,
          designProviderId: 'old-connection',
          designModelId: 'custom-model',
        },
      })),
    });
    root = await mount(
      controls({ port: api, voices: flashCatalog(), voiceLibrary: libraryPort(), engines: twoEngines() }),
    );
    expect(mode(root)).toBe('create');
    expect(modeCard(root, 'create').props.checked).toBe(true);
    expect(text(root)).toContain('내레이터가 Gemini 3.8 Flash TTS 목소리일 때만 쓸 수 있어요.');
    expect(text(root)).toContain('새 목소리 만들기는 내레이터가 Gemini 3.8 Flash TTS일 때만 쓸 수 있어요.');
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
    expect(api.savePreferences).not.toHaveBeenCalled();
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'g1' } }));
    await flush();
    expect(vi.mocked(api.savePreferences).mock.lastCall![0].casting).toMatchObject({
      designProviderId: 'designer',
      designModelId: 'gemini-3.8-flash-tts',
      maxDesignedVoices: 2,
    });
    expect(button(root, '생성 전 확인').props.disabled).toBe(false);
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0].casting).toMatchObject({
      designProviderId: 'designer',
      designModelId: 'gemini-3.8-flash-tts',
    });
  });

  it('offers request batching off by default for Gemini 3.8 voices only and sends it only when turned on', async () => {
    const api = port();
    let root = await mount(controls({ port: api }));
    expect(root.findAll((n) => n.props.id === 'un-cast-batch')).toHaveLength(0);
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0]).not.toHaveProperty('batchAudio');
    act(() => renderer!.unmount());

    const props = controls({ port: api, voices: flashCatalog('gemini-3.8-flash-lite-tts'), narratorVoiceId: 'g1' });
    root = await mount(props);
    const toggle = () => castingField(root, '이어지는 대사 묶어 만들기');
    expect(toggle().props.checked).toBe(false);
    expect(api.savePreferences).not.toHaveBeenCalled();
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0]).not.toHaveProperty('batchAudio');
    act(() => toggle().props.onChange({ target: { checked: true } }));
    await flush();
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ batchAudio: true }));
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(api.estimate).mock.lastCall![0].batchAudio).toBe(true);
    expect(text(root.findByProps({ 'aria-label': '생성 확인' }))).toContain('요청 묶기켬');

    // A saved 'on' is restored, but never sent through voices that cannot batch.
    act(() => renderer!.unmount());
    const saved = port(async () => [], {
      preferences: vi.fn(async () => ({
        engineId: 'e1',
        narratorVoiceId: 'a1',
        characterVoiceIds: ['a2'],
        batchAudio: true,
      })),
    });
    root = await mount(controls({ port: saved, voices: flashCatalog() }));
    expect(root.findAll((n) => n.props.id === 'un-cast-batch')).toHaveLength(0);
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(saved.estimate).mock.lastCall![0]).not.toHaveProperty('batchAudio');
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'g1' } }));
    await flush();
    expect(castingField(root, '이어지는 대사 묶어 만들기').props.checked).toBe(true);
    expect(text(root)).toContain('Gemini 3.8 Flash·Lite 목소리만 묶여요.');
  });

  it('turns automatic acting on by default for capable voices, remembers an explicit off, and stays off for others', async () => {
    const api = port();
    const acting = catalog();
    acting.voices = acting.voices.map((voice) =>
      voice.providerId === 'tts-a' ? { ...voice, autoActingSupported: true } : voice,
    );
    const root = await mount(controls({ port: api, voices: acting }));
    const toggle = () => castingField(root, '감정·속도 살려 읽기');
    expect(toggle().props.checked).toBe(true);
    expect(api.savePreferences).not.toHaveBeenCalled();
    await click(button(root, '생성 전 확인'));
    expect(api.estimate).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoActing: true }),
      expect.any(AbortSignal),
    );

    act(() => toggle().props.onChange({ target: { checked: false } }));
    await flush();
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ autoActing: false }));
    await click(button(root, '생성 전 확인'));
    expect(api.estimate).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoActing: false }),
      expect.any(AbortSignal),
    );

    // An explicit on that later meets an unsupported voice is kept and blocks instead of switching off.
    act(() => toggle().props.onChange({ target: { checked: true } }));
    await flush();
    await click(button(root, /^외부 1/));
    expect(toggle().props.checked).toBe(true);
    expect(text(root)).toContain('장면 연기를 지원하지 않는 목소리가 있어요');
    expect(text(root)).toContain('지원하지 않는 목소리가 있어 쓸 수 없어요: 외부 1');
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);

    act(() => renderer!.unmount());
    const plain = port();
    const other = await mount(controls({ port: plain }));
    expect(castingField(other, '감정·속도 살려 읽기').props.checked).toBe(false);
    expect(text(other)).toContain('지금 고른 목소리로는 쓸 수 없어요.');
    expect(text(other)).not.toContain('장면 연기를 지원하지 않는 목소리가 있어요');
    await click(button(other, '생성 전 확인'));
    expect(vi.mocked(plain.estimate).mock.lastCall![0]).not.toHaveProperty('autoActing');
  });

  it('keeps a legacy major-only design choice, restores the model after order, and blocks it off Flash', async () => {
    const saved = (casting: SpeakerGenerationPreferences['casting'], narratorVoiceId = 'a1') =>
      port(async () => [], {
        preferences: vi.fn(async () => ({
          engineId: 'e1',
          narratorVoiceId,
          characterVoiceIds: ['a2'],
          casting,
        })),
      });
    const noDesigners = { ...libraryPort(), list: vi.fn(async () => ({ voices: [], designers: [] })) };
    const twoEngines = () =>
      engines(async () => [engine(), engine({ id: 'cast', purpose: 'casting', name: '선정용' })]);
    const legacy = { engineId: 'cast', autoDesign: true, maxDesignedVoices: 2, designProviderId: 'designer' };
    const api = saved(legacy);
    let root = await mount(controls({ port: api, voiceLibrary: noDesigners, engines: twoEngines() }));
    expect(mode(root)).toBe('pick');
    expect(castingField(root, '주요 인물은 새 목소리로 만들기').props.checked).toBe(true);
    expect(hasMode(root, 'create')).toBe(false);
    expect(text(root)).toContain('새 목소리 만들기는 내레이터가 Gemini 3.8 Flash TTS일 때만 쓸 수 있어요.');
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
    expect(api.savePreferences).not.toHaveBeenCalled();
    await chooseMode(root, 'order');
    expect(vi.mocked(api.savePreferences).mock.lastCall![0].casting?.engineId).toBeUndefined();
    await chooseMode(root, 'pick');
    expect(vi.mocked(api.savePreferences).mock.lastCall![0].casting?.engineId).toBe('cast');

    act(() => renderer!.unmount());
    // Under a Flash narrator the same saved choice works and is sent on that narrator's connection.
    const flash = saved({ ...legacy, designProviderId: 'gone', designModelId: 'm' }, 'g1');
    root = await mount(
      controls({ port: flash, voices: flashCatalog(), voiceLibrary: libraryPort(), engines: twoEngines() }),
    );
    expect(mode(root)).toBe('pick');
    expect(castingField(root, '주요 인물은 새 목소리로 만들기').props.checked).toBe(true);
    await click(button(root, '생성 전 확인'));
    expect(vi.mocked(flash.estimate).mock.lastCall![0].casting).toMatchObject({
      autoDesign: true,
      designProviderId: 'designer',
      designModelId: 'gemini-3.8-flash-tts',
    });
  });

  it('opens model and voice management without resetting the selected casting mode', async () => {
    const manageEngines = vi.fn(),
      manageVoices = vi.fn();
    const props = controls({
      voiceLibrary: libraryPort(),
      engines: engines(async () => [engine(), engine({ id: 'cast', purpose: 'casting', name: '선정용' })]),
    });
    const root = await mount(props, { onManageEngines: manageEngines, onManageVoices: manageVoices });
    await chooseMode(root, 'pick');
    expect(castingField(root, '배정 AI 모델').props.value).toBe('cast');
    await click(button(root, '모델 연결'));
    await click(button(root, '목소리 보관함'));
    expect(manageEngines).toHaveBeenCalledTimes(1);
    expect(manageVoices).toHaveBeenCalledTimes(1);
    expect(castingField(root, '배정 AI 모델').props.value).toBe('cast');
  });
});
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
const matches = (node: ReactTestInstance, name: string | RegExp) => {
  if (node.type !== 'button') return false;
  const label = node.props['aria-label'] ?? text(node).trim();
  return typeof name === 'string' ? name === label : name.test(label);
};
const button = (root: ReactTestInstance, name: string | RegExp) => root.find((node) => matches(node, name));
const hasButton = (root: ReactTestInstance, name: string | RegExp) =>
  root.findAll((node) => matches(node, name)).length > 0;
const select = (root: ReactTestInstance, label: string) => root.findByProps({ 'aria-label': label });
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
  await flush();
}

describe('UiNextSpeakerGenerationPanel creating', () => {
  it('keeps the analysis model and TTS voices apart and pools the narrator engine by default', async () => {
    const root = await mount(controls());
    expect(text(root)).toContain('실험 기능');
    expect(select(root, '분석 모델').props.value).toBe('e1');
    expect(select(root, '내레이터 목소리').props.value).toBe('a1');
    // Narrator excluded; the paid voice on another engine is never pulled in by itself.
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(true);
    expect(button(root, /^목소리 3/).props['aria-pressed']).toBe(true);
    expect(button(root, /^외부 1/).props['aria-pressed']).toBe(false);
    expect(button(root, /^목소리 1/).props.disabled).toBe(false);
    expect(button(root, /^목소리 1/).props['aria-pressed']).toBe(false);
    await click(button(root, /^목소리 1/));
    expect(button(root, /^목소리 1/).props['aria-pressed']).toBe(true);
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(true);
  });

  it('shows the real analysis range, then asks for paid consent before creating once', async () => {
    const api = port(async () => [], { estimate: vi.fn(async () => estimate({ paid: true, contextChapterCount: 1 })) });
    const root = await mount(controls({ port: api }));

    await click(button(root, /^외부 1/));
    await click(button(root, '생성 전 확인'));
    expect(api.estimate).toHaveBeenCalledWith(
      {
        chapterIds: ['c2'],
        engineId: 'e1',
        narratorVoiceId: 'a1',
        characterVoiceIds: ['a2', 'a3', 'b1'],
        rules: [],
        footnotePlayback: 'skip',
      },
      expect.any(AbortSignal),
    );
    const confirm = text(root.findByProps({ 'aria-label': '생성 확인' }));
    expect(confirm).toContain('앞 회차(분석만)');
    expect(confirm).toContain('앞 1개 회차도 읽어요');
    expect(confirm).toContain('분석 A · model-a');
    expect(button(root, '생성 시작').props.disabled).toBe(true);

    act(() => castingField(root, '유료 API 요금이 나올 수 있어요').props.onChange({ target: { checked: true } }));
    // Two clicks before the first reply lands still start one job.
    let release!: () => void;
    vi.mocked(api.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(job({ status: 'queued', stage: 'waiting', readyChapterIds: [] }));
        }),
    );
    act(() => {
      button(root, '생성 시작').props.onClick();
      button(root, '생성 시작').props.onClick();
    });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.create).mock.calls[0]![1]).toBe('fp-1');
    expect(vi.mocked(api.create).mock.calls[0]![2]).toBe(true);
    vi.mocked(api.list).mockResolvedValue([job({ status: 'queued', stage: 'waiting', readyChapterIds: [] })]);
    await act(async () => release());
    await flush();
    expect(text(root)).toContain('대기 중');
    expect(text(root)).toContain('차례를 기다리는 중');
  });

  it('drops a confirmed estimate when the voice pool changes', async () => {
    const api = port();
    const root = await mount(controls({ port: api }));
    await click(button(root, '생성 전 확인'));
    expect(hasButton(root, '생성 시작')).toBe(true);
    await click(button(root, /^목소리 3/));
    expect(hasButton(root, '생성 시작')).toBe(false);
    expect(hasButton(root, '생성 전 확인')).toBe(true);
  });

  it('keeps choices when the model and voice lists reload, showing a missing one instead of swapping', async () => {
    let list = [engine(), engine({ id: 'e2', name: '분석 B', modelId: 'model-b' })];
    const enginePort = engines(async () => list);
    const props = controls({ engines: enginePort });
    act(() => {
      renderer = create(<UiNextSpeakerGenerationPanel controls={props} enginesRevision={0} />);
    });
    await flush();
    const root = renderer!.root;
    act(() => select(root, '분석 모델').props.onChange({ target: { value: 'e2' } }));
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'a2' } }));

    list = [engine()];
    act(() =>
      renderer!.update(
        <UiNextSpeakerGenerationPanel
          controls={{ ...props, voices: catalog({ voices: catalog().voices.filter((voice) => voice.id !== 'a2') }) }}
          enginesRevision={1}
        />,
      ),
    );
    await flush();
    expect(select(root, '분석 모델').props.value).toBe('e2');
    expect(text(select(root, '분석 모델'))).toContain('목록에 없는 분석 모델');
    expect(select(root, '내레이터 목소리').props.value).toBe('a2');
    expect(text(root)).toContain('목록에 없는 목소리 · a2');
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
  });

  it('sends people to connect an analysis model when none exist', async () => {
    const onManageEngines = vi.fn();
    const root = await mount(controls({ engines: engines(async () => []) }), { onManageEngines });
    expect(text(root)).toContain('아직 연결한 분석 모델이 없어요');
    await click(button(root, '분석 모델 연결'));
    expect(onManageEngines).toHaveBeenCalled();
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
  });
});

describe('UiNextSpeakerGenerationPanel jobs', () => {
  it('shows the current analysis chapter instead of zero audio totals while the plan is unknown', async () => {
    const root = await mount(
      controls({
        port: port(async () => [
          job({
            stage: 'identity',
            itemCount: 0,
            completedItems: 0,
            bytes: 0,
            readyChapterIds: [],
            analyzedChapters: 1,
            chapterCount: 1,
            contextChapterCount: 68,
            planningComplete: false,
            analysisProgress: {
              chapterCount: 69,
              currentChapter: { number: 2, title: '중립적인 두 번째 회차', contextOnly: true },
            },
          }),
        ]),
      }),
    );
    expect(text(root)).toContain('인물 연결 중');
    expect(text(root)).toContain('69개 중 2번째 회차');
    expect(text(root)).toContain('인물 파악을 위한 앞 회차');
    expect(text(root)).toContain('분석 완료 1 / 69회차');
    expect(text(root)).not.toContain('화자 찾기 완료');
    expect(text(root)).toContain('음성 구간 수는 회차 분석 후 표시돼요.');
    expect(text(root)).not.toContain('0 / 0 구간');
    expect(text(root)).not.toContain('0 B');
    expect(root.findByProps({ 'aria-label': '회차 분석 진행' })).toBeDefined();
    expect(button(root, '본문에서 듣기').props.disabled).toBe(true);
  });

  it('shows parallel attribution ahead of fully analyzed chapters without a second bar', async () => {
    const root = await mount(
      controls({
        port: port(async () => [
          job({
            stage: 'identity',
            itemCount: 0,
            analyzedChapters: 1,
            analysisProgress: { chapterCount: 69, attributionCompleted: 5 },
          }),
        ]),
      }),
    );
    expect(text(root)).toContain('화자 찾기 완료 5 / 69회차');
    expect(text(root)).toContain('분석 완료 1 / 69회차');
    expect(root.findAllByProps({ role: 'progressbar' })).toHaveLength(1);
  });

  it('shows scheduled rate-limit waiting without claiming the model is processing or repeating an old wait duration', async () => {
    const retryAt = new Date(Date.now() + 300000).toISOString();
    const root = await mount(
      controls({
        port: port(async () => [
          job({
            status: 'queued',
            itemCount: 0,
            completedItems: 0,
            bytes: 0,
            readyChapterIds: [],
            retryAt,
            stage: 'casting',
            error: '목소리 제작 요청 제한으로 대기 중 · 300초 후 자동으로 이어 만들어요.',
          }),
          // No server wording: a generic headline instead of nothing.
          job({ id: 'job-2', status: 'queued', stage: 'audio', retryAt, error: undefined }),
        ]),
      }),
    );
    // The server names the waiting step; the stale seconds tail is dropped for the live retry time.
    expect(text(root)).toContain('목소리 제작 요청 제한으로 대기 중');
    expect(text(root)).not.toContain('대기 중 ·');
    expect(text(root)).toContain('요청 제한으로 대기 중');
    expect(text(root)).toContain('자동으로 다시 시도해요.');
    expect(root.findAllByType('time')[0].props.dateTime).toBe(retryAt);
    expect(text(root)).not.toContain('300초');
    expect(text(root)).not.toContain('목소리 배정 중');
    expect(root.findAll((n) => n.type === 'svg' && String(n.props.className).includes('un-spin'))).toHaveLength(0);
    expect(root.findAll((n) => matches(n, '멈추기')).every((n) => n.props.disabled !== true)).toBe(true);
  });

  it('labels a long book voice memo as selection notes, folded until asked', async () => {
    const memo =
      '30대 남성, 낮고 차분한 중저음. 평소에는 느긋하고 정중하게 말하지만 화가 나면 짧게 끊어 말한다. 낯선 사람에게도 존댓말을 쓴다.';
    const castings = vi.fn(async () => [
      {
        speakerId: 'p1',
        name: '인물 1',
        voiceId: 'a2',
        alias: '',
        timbre: '',
        description: memo,
        importance: 'major' as const,
        pinned: false,
      },
      {
        speakerId: 'p2',
        name: '인물 2',
        voiceId: 'a3',
        alias: '',
        timbre: '',
        description: '',
        importance: 'extra' as const,
        pinned: false,
      },
    ]);
    const root = await mount(controls({ port: port(async () => [job({ status: 'completed' })], { castings }) }));
    const details = root.findAll((n) => n.type === 'details' && text(n).includes('작품 기본 목소리'))[0];
    act(() => details.props.onToggle({ currentTarget: { open: true } }));
    await flush();
    expect(text(root)).toContain('인물 특징은 목소리를 정할 때 참고한 메모예요. 장면별 감정·말투는 따로 정해요.');
    expect(text(root)).toContain('인물 특징' + memo);
    // The stored text is shown as is; nothing is sent back to a model.
    expect(castings).toHaveBeenCalledTimes(1);
    expect(root.findAll((n) => n.type === 'small' && n.props.className === 'is-open')).toHaveLength(0);
    await click(button(root, '더 보기'));
    expect(root.findAll((n) => n.type === 'small' && n.props.className === 'is-open')).toHaveLength(1);
    expect(hasButton(root, '접기')).toBe(true);
  });

  it('explains resume before any audio plan exists and labels partial plan counts', async () => {
    const api = port(async () => [
      job({
        status: 'failed',
        stage: 'attribution',
        paid: true,
        planningComplete: false,
        itemCount: 0,
        completedItems: 0,
        readyChapterIds: [],
        error: '분석 응답 오류',
      }),
    ]);
    const root = await mount(controls({ port: api }));
    expect(text(root)).toContain('화자 찾기 단계에서 중단됐어요');
    await click(button(root, '다시 시도'));
    expect(text(root)).toContain('남은 회차를 이어서 만들어요.');
    expect(text(root)).not.toContain('남은 0개 구간');
    vi.mocked(api.list).mockResolvedValue([job({ planningComplete: false })]);
    await click(button(root, '목록 새로고침'));
    expect(text(root)).toContain('지금까지 계획된 음성 4 / 10 구간');
    expect(root.findByProps({ 'aria-label': '회차 분석 진행' })).toBeDefined();
    expect(root.findAllByProps({ 'aria-label': '생성 진행' })).toHaveLength(0);
  });
  it('shows the stage and ready chapters, and plays a partly made job in the reader', async () => {
    const listen = vi.fn();
    const root = await mount(controls({ port: port(async () => [job()]), listen }));
    const steps = root.findByProps({ 'aria-label': '진행 단계' });
    expect(text(steps)).toBe('화자 찾기인물 연결목소리 배정음성 만들기');
    expect(steps.findByProps({ 'aria-current': 'step' }).children).toEqual(['음성 만들기']);
    expect(text(root)).toContain('앞 회차 1개 포함');
    expect(text(root)).toContain('들을 수 있는 회차 1/2');
    await click(button(root, '본문에서 듣기'));
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }));
  });

  it('cannot play before any chapter is ready', async () => {
    const root = await mount(
      controls({ port: port(async () => [job({ stage: 'attribution', readyChapterIds: [] })]) }),
    );
    expect(button(root, '본문에서 듣기').props.disabled).toBe(true);
  });

  it('pauses, retries a failed job with paid consent, and confirms removal', async () => {
    const api = port(async () => [job({ status: 'failed', paid: true, error: '요청 한도에 걸렸어요.' })]);
    const root = await mount(controls({ port: api }));
    expect(text(root)).toContain('요청 한도에 걸렸어요.');
    await click(button(root, '다시 시도'));
    expect(api.control).not.toHaveBeenCalled();
    await click(button(root, '이어 만들기'));
    expect(api.control).toHaveBeenCalledWith('job-1', 'resume', true);

    vi.mocked(api.list).mockResolvedValue([
      job({ status: 'completed', stage: 'complete', readyChapterIds: ['c2', 'c3'] }),
    ]);
    await click(button(root, '목록 새로고침'));
    await click(button(root, '음성만 삭제'));
    await click(button(root, '삭제'));
    expect(api.remove).toHaveBeenCalledWith('job-1');
  });

  it('replaces retry with a confirmed skip when the voice service refused content', async () => {
    const api = port(async () => [
      job({
        status: 'failed',
        paid: true,
        completedItems: 4,
        blockedItems: 1,
        blockedAudio: [{ ordinal: 4, chapterTitle: '3화', reason: 'SAFETY' }],
      }),
    ]);
    const root = await mount(controls({ port: api }));
    expect(hasButton(root, '다시 시도')).toBe(false);
    expect(text(root)).toContain('콘텐츠 제한 구간에서 멈췄어요');
    expect(text(root)).toContain('3화작업 내 5번 구간');
    expect(text(root)).not.toContain('앞 1개만');

    await click(button(root, '건너뛰고 계속'));
    expect(api.control).not.toHaveBeenCalled();
    expect(text(root)).toContain('남은 5개 구간');
    expect(text(root)).toContain('요금');
    await click(button(root, '건너뛰고 계속'));
    expect(api.control).toHaveBeenCalledWith('job-1', 'skip-blocked', true);
  });

  it('counts skipped segments as progress and says later blocks skip automatically', async () => {
    const root = await mount(
      controls({ port: port(async () => [job({ completedItems: 4, skippedItems: 2, skipBlockedAudio: true })]) }),
    );
    expect(text(root)).toContain('처리 6 / 10 구간');
    expect(text(root)).toContain('음성 없이 넘긴 구간 2개 · 콘텐츠 제한 구간은 자동으로 넘겨요');
  });

  it('starts over for another account without letting the old list land', async () => {
    let release!: (jobs: SpeakerGenerationJob[]) => void;
    const slow = port(() => new Promise((resolve) => (release = resolve)));
    const props = controls({ port: slow });
    act(() => {
      renderer = create(<UiNextSpeakerGenerationPanel controls={props} />);
    });
    await flush();
    act(() =>
      renderer!.update(
        <UiNextSpeakerGenerationPanel controls={{ ...props, key: 'account-2:novel-1', port: port(async () => []) }} />,
      ),
    );
    await flush();
    await act(async () => release([job()]));
    await flush();
    expect(text(renderer!.root)).not.toContain('2화 ~ 3화');
    expect(text(renderer!.root)).toContain('아직 없어요');
  });
});

describe('UiNextSpeakerGenerationPanel cleanup', () => {
  const preview = (overrides = {}) => ({
    fingerprint: 'clean-1',
    jobCount: 2,
    audioBytes: 2048,
    assignmentCount: 5,
    analysisCount: 3,
    ...overrides,
  });
  const option = (root: ReactTestInstance, title: string) => castingField(root, title);

  it('starts with nothing picked, shows what each choice removes and what always stays', async () => {
    const previewCleanup = vi.fn(async (options: { analysis: boolean; audio: boolean }) =>
      preview(
        options.analysis && !options.audio
          ? { blockedReason: '분석이 끝나지 않은 생성 작업도 함께 삭제해 주세요.' }
          : {},
      ),
    );
    const cleanup = vi.fn(async () => ({ removedJobs: 2, removedAssignments: 0, removedAnalyses: 3 }));
    const api = port(async () => [], { previewCleanup, cleanup });
    const root = await mount(controls({ port: api }));
    expect(previewCleanup).not.toHaveBeenCalled();
    await click(button(root, '초기화·삭제'));
    const run = () => button(root, '선택한 항목 지우기');
    for (const title of ['만든 음성·생성 작업', '인물 목소리 배정·생성 설정', '화자 분석 기록'])
      expect(option(root, title).props.checked).toBe(false);
    expect(run().props.disabled).toBe(true);
    expect(text(root)).toContain('2개 · 2 KB');
    expect(text(root)).toContain('인물 5명');
    expect(text(root)).toContain('화자 분석 기록은 남아요.');
    expect(text(root)).toContain('목소리 보관함과 TTS·분석 모델 연결은 그대로예요.');

    act(() => option(root, '화자 분석 기록').props.onChange());
    await flush();
    expect(previewCleanup).toHaveBeenLastCalledWith(
      { audio: false, settings: false, analysis: true },
      expect.any(AbortSignal),
    );
    expect(text(root)).toContain('분석이 끝나지 않은 생성 작업도 함께 삭제해 주세요.');
    expect(text(root)).not.toContain('화자 분석 기록은 남아요.');
    expect(run().props.disabled).toBe(true);
    act(() => option(root, '만든 음성·생성 작업').props.onChange());
    await flush();
    expect(text(root)).toContain('되돌릴 수 없어요.');
    await click(run());
    expect(cleanup).toHaveBeenCalledWith({ audio: true, settings: false, analysis: true }, 'clean-1', true);
    expect(text(root)).toContain('정리했어요: 음성 작업 2개, 분석 기록 3개.');
  });

  it('resets saved choices to the defaults after pending saves, without saving them back', async () => {
    const order: string[] = [];
    const api = port(async () => [], {
      preferences: vi.fn(async () => ({ engineId: 'e1', narratorVoiceId: 'a2', characterVoiceIds: ['a3'] })),
      previewCleanup: vi.fn(async () => preview()),
      cleanup: vi.fn(async () => {
        order.push('cleanup');
        return {
          removedJobs: 0,
          removedAssignments: 5,
          removedAnalyses: 0,
          preferences: { engineId: 'e1', narratorVoiceId: '', characterVoiceIds: [] },
        };
      }),
    });
    vi.mocked(api.savePreferences).mockImplementation(async () => {
      order.push('save');
    });
    const root = await mount(controls({ port: api }));
    expect(select(root, '내레이터 목소리').props.value).toBe('a2');
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'a3' } }));
    await click(button(root, '초기화·삭제'));
    act(() => option(root, '인물 목소리 배정·생성 설정').props.onChange());
    await flush();
    await click(button(root, '선택한 항목 지우기'));
    expect(order).toEqual(['save', 'cleanup']);
    // Narrator back to the listen setting, pool back to its engine; nothing written by the reset itself.
    expect(select(root, '내레이터 목소리').props.value).toBe('a1');
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(true);
    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain('정리했어요: 인물 배정 5명.');
  });

  it('reopens a reset as the defaults, but keeps a pool emptied by hand', async () => {
    const reset = port(async () => [], {
      preferences: vi.fn(async () => ({ engineId: 'e1', narratorVoiceId: '', characterVoiceIds: [] })),
    });
    let root = await mount(controls({ port: reset }));
    expect(select(root, '내레이터 목소리').props.value).toBe('a1');
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(true);
    expect(button(root, /^목소리 3/).props['aria-pressed']).toBe(true);
    act(() => renderer!.unmount());
    const emptied = port(async () => [], {
      preferences: vi.fn(async () => ({ engineId: 'e1', narratorVoiceId: 'a1', characterVoiceIds: [] })),
    });
    root = await mount(controls({ port: emptied }));
    expect(button(root, /^목소리 2/).props['aria-pressed']).toBe(false);
    expect(text(root)).toContain('인물 목소리를 하나 이상 골라 주세요.');
  });

  it('waits for running jobs to stop', async () => {
    const api = port(async () => [job({ status: 'running' })], {
      previewCleanup: vi.fn(async () => preview()),
      cleanup: vi.fn(),
    });
    const root = await mount(controls({ port: api }));
    await click(button(root, '초기화·삭제'));
    act(() => option(root, '만든 음성·생성 작업').props.onChange());
    await flush();
    expect(text(root)).toContain('만드는 중인 작업을 멈춘 뒤 초기화할 수 있어요.');
    expect(button(root, '선택한 항목 지우기').props.disabled).toBe(true);
  });
});

describe('UiNextSpeakerGenerationPanel saved choices', () => {
  it('restores saved choices as they are, missing ids included, without saving them back', async () => {
    const api = port();
    vi.mocked(api.preferences).mockResolvedValue({
      engineId: 'gone',
      narratorVoiceId: 'a2',
      characterVoiceIds: ['a3', 'x9'],
    });
    const root = await mount(controls({ port: api }));
    expect(select(root, '분석 모델').props.value).toBe('gone');
    expect(text(select(root, '분석 모델'))).toContain('목록에 없는 분석 모델');
    expect(select(root, '내레이터 목소리').props.value).toBe('a2');
    expect(button(root, /^목소리 3/).props['aria-pressed']).toBe(true);
    expect(button(root, /^목소리 1/).props['aria-pressed']).toBe(false);
    expect(text(root)).toContain('목록에 없음 · x9');
    expect(api.savePreferences).not.toHaveBeenCalled();
  });

  it('uses the defaults without saving when nothing is stored, and saves the whole choice on a change', async () => {
    const api = port();
    const root = await mount(controls({ port: api }));
    expect(select(root, '내레이터 목소리').props.value).toBe('a1');
    expect(api.savePreferences).not.toHaveBeenCalled();
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'a2' } }));
    await flush();
    expect(api.savePreferences).toHaveBeenCalledWith({
      engineId: 'e1',
      narratorVoiceId: 'a2',
      characterVoiceIds: ['a1', 'a3'],
    });
  });

  it('sends saves one at a time and only the newest of a burst', async () => {
    const api = port();
    const releases: (() => void)[] = [];
    vi.mocked(api.savePreferences).mockImplementation(
      () => new Promise<undefined>((resolve) => releases.push(() => resolve(undefined))),
    );
    const root = await mount(controls({ port: api }));
    await click(button(root, /^목소리 2/));
    await click(button(root, /^목소리 3/));
    await click(button(root, /^외부 1/));
    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    await act(async () => releases[0]!());
    await flush();
    expect(api.savePreferences).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.savePreferences).mock.calls[1]![0].characterVoiceIds).toEqual(['b1']);
  });

  it('finishes a save after the page closes and reopens with that choice instead of an older read', async () => {
    const api = port();
    let release!: () => void;
    vi.mocked(api.savePreferences).mockImplementation(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const props = controls({
      port: api,
      engines: engines(async () => [engine(), engine({ id: 'e2', name: '분석 B', modelId: 'model-b' })]),
    });
    let root = await mount(props);
    act(() => select(root, '분석 모델').props.onChange({ target: { value: 'e2' } }));
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => release());
    expect(api.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'e2' }));

    vi.mocked(api.preferences).mockResolvedValue({ engineId: 'e1', narratorVoiceId: 'a1', characterVoiceIds: ['a2'] });
    root = await mount(props);
    expect(api.preferences).toHaveBeenCalledTimes(1);
    expect(select(root, '분석 모델').props.value).toBe('e2');
  });

  it('never saves defaults over choices it could not read', async () => {
    const api = port();
    vi.mocked(api.preferences).mockRejectedValue(new Error('offline'));
    const root = await mount(controls({ port: api }));
    expect(text(root)).toContain('저장한 설정을 불러오지 못했어요');
    act(() => select(root, '내레이터 목소리').props.onChange({ target: { value: 'a2' } }));
    await flush();
    expect(select(root, '내레이터 목소리').props.value).toBe('a2');
    expect(api.savePreferences).not.toHaveBeenCalled();
  });

  it('waits for saved choices before offering to estimate', async () => {
    const api = port();
    vi.mocked(api.preferences).mockImplementation(() => new Promise(() => {}));
    const root = await mount(controls({ port: api }));
    expect(select(root, '내레이터 목소리').props.disabled).toBe(true);
    expect(button(root, '생성 전 확인').props.disabled).toBe(true);
  });
});
