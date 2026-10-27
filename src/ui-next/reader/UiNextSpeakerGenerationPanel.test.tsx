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
async function mount(props: TTSSpeakerGenerationControls, extra: { onManageEngines?: () => void } = {}) {
  act(() => {
    renderer = create(<UiNextSpeakerGenerationPanel controls={props} {...extra} />);
  });
  await flush();
  return renderer!.root;
}
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
    expect(button(root, /^목소리 1/).props.disabled).toBe(true);
  });

  it('shows the real analysis range, then asks for paid consent before creating once', async () => {
    const api = port(async () => [], { estimate: vi.fn(async () => estimate({ paid: true, contextChapterCount: 1 })) });
    const root = await mount(controls({ port: api }));

    await click(button(root, /^외부 1/));
    await click(button(root, '분석 범위 확인'));
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
    expect(confirm).toContain('함께 분석할 앞 회차');
    expect(confirm).toContain('앞 1개 회차도 분석해요');
    expect(confirm).toContain('분석 A · model-a');
    expect(button(root, '생성 시작').props.disabled).toBe(true);

    act(() =>
      root
        .findAll((node) => node.type === 'input' && node.props.type === 'checkbox')[0]!
        .props.onChange({ target: { checked: true } }),
    );
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
    await click(button(root, '분석 범위 확인'));
    expect(hasButton(root, '생성 시작')).toBe(true);
    await click(button(root, /^목소리 3/));
    expect(hasButton(root, '생성 시작')).toBe(false);
    expect(hasButton(root, '분석 범위 확인')).toBe(true);
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
    expect(button(root, '분석 범위 확인').props.disabled).toBe(true);
  });

  it('sends people to connect an analysis model when none exist', async () => {
    const onManageEngines = vi.fn();
    const root = await mount(controls({ engines: engines(async () => []) }), { onManageEngines });
    expect(text(root)).toContain('아직 연결한 분석 모델이 없어요');
    await click(button(root, '분석 모델 연결'));
    expect(onManageEngines).toHaveBeenCalled();
    expect(button(root, '분석 범위 확인').props.disabled).toBe(true);
  });
});

describe('UiNextSpeakerGenerationPanel jobs', () => {
  it('shows the stage and ready chapters, and plays a partly made job in the reader', async () => {
    const listen = vi.fn();
    const root = await mount(controls({ port: port(async () => [job()]), listen }));
    const steps = root.findByProps({ 'aria-label': '진행 단계' });
    expect(text(steps)).toBe('화자 찾기인물 연결음성 만들기');
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
    await click(button(root, '음성 삭제'));
    await click(button(root, '삭제'));
    expect(api.remove).toHaveBeenCalledWith('job-1');
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
    expect(text(root)).toContain('저장해 둔 선택을 불러오지 못했어요');
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
    expect(button(root, '분석 범위 확인').props.disabled).toBe(true);
  });
});
