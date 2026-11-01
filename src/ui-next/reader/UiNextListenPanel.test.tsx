import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProviderSettingsPanel from '../../features/providers/ProviderSettingsPanel';
import TTSAddonPanel, { type TTSAddonPanelProps } from '../../features/tts/TTSAddonPanel';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import UiNextListenPanel from './UiNextListenPanel';
import UiNextTTSConnections from './UiNextTTSConnections';
import UiNextSpeakerEngines from './UiNextSpeakerEngines';
import UiNextSpeakerGenerationPanel from './UiNextSpeakerGenerationPanel';
import type { TTSSpeakerGenerationControls } from '../../providers/speaker-generation';
import { usePlainTTS } from '../../features/tts/usePlainTTS';
import { useTTSExecutionController } from '../../features/tts/useTTSExecutionController';
import { buildPlainTTSBatch } from '../../providers/plain-tts';
import type { Paragraph } from '../../domain/types';
import type { TTSConnection, TTSConnectionsPort } from '../../providers/tts-connections';

// Who may open 서버 관리: the server must expose management and the account must hold manageServer.
const access = vi.hoisted(() => ({ managed: false, manageServer: true }));
vi.mock('../../features/server-management/use-server-management-client', () => ({
  serverManagementApi: () => (access.managed ? {} : undefined),
}));
vi.mock('../../features/auth/self-host-account-api', () => ({
  useSelfHostCapability: (capability: string) => (capability === 'manageServer' ? access.manageServer : true),
}));

// Use the existing TTSAddonPanel fixture's ports with separate spies for each action.
function fixture(overrides: Partial<TTSAddonPanelProps> = {}): TTSAddonPanelProps {
  return {
    statusTone: 'ready',
    selectedVoiceMissing: false,
    unavailable: false,
    hostedPlaybackReady: false,
    paragraphCount: 10,
    paragraphIndex: 2,
    playing: false,
    paused: false,
    speed: 1,
    playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS },
    bookOverrideEnabled: false,
    pitchSupported: true,
    voices: [],
    characters: [],
    voiceProfiles: [],
    selectedHostedProviderLabel: '선택 안 됨',
    selectedHostedVoices: [],
    hostedBusy: false,
    hostedWarmupDisabled: true,
    offlineDownloadJob: undefined,
    offlineDownloadError: undefined,
    offlineDownloadPolicy: undefined,
    hostedOfflineCacheStatus: undefined,
    providers: [],
    providerController: {
      available: false,
      loading: false,
      secretStatuses: [],
      secretDrafts: {},
      desktopMode: false,
      analysisRunning: false,
      hostedTTSBusy: false,
      updateDraft: vi.fn(),
      updateSecretDraft: vi.fn(),
      refresh: vi.fn(),
      saveSettings: vi.fn(),
      saveSecret: vi.fn(),
      deleteSecret: vi.fn(),
      testSecret: vi.fn(),
      runDesktopLLMSample: vi.fn(),
      playDesktopTTSSample: vi.fn(),
    },
    voiceProductBusy: false,
    voiceProductSummary: { major: 0, approved: 0, stale: 0 },
    spokenTextRules: [],
    voicePoolViews: {},
    bookCharacterCount: 0,
    refreshStatus: vi.fn(),
    jump: vi.fn(),
    start: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    changeSpeed: vi.fn(),
    changePlaybackSettings: vi.fn(),
    setBookOverrideEnabled: vi.fn(),
    resetBookOverride: vi.fn(),
    resumeSavedPlayback: vi.fn(),
    changeSystemVoice: vi.fn(),
    saveSystemVoice: vi.fn(),
    saveHostedVoice: vi.fn(),
    saveHostedVoiceOption: vi.fn(),
    refreshHostedVoices: vi.fn(),
    warmup: vi.fn(),
    changeOfflineDownloadPolicy: vi.fn(),
    requestHostedOfflineStorage: vi.fn(),
    removeStaleHostedOfflineAudio: vi.fn(),
    generateVoiceDraft: vi.fn(),
    saveVoicePool: vi.fn(),
    playVoiceSample: vi.fn(),
    decideVoice: vi.fn(),
    savePronunciationRule: vi.fn(),
    deletePronunciationRule: vi.fn(),
    saveSpokenTextSkipRule: vi.fn(),
    deleteSpokenTextSkipRule: vi.fn(),
    previewSpokenTextRuleImpact: async () => ({
      scannedParagraphCount: 0,
      affectedParagraphCount: 0,
      fullySkippedParagraphCount: 0,
      skippedRangeCount: 0,
      samples: [],
    }),
    setMinorFallbackEnabled: vi.fn(),
    setMajorCharacterLimit: vi.fn(),
    ...overrides,
  };
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  access.managed = false;
  access.manageServer = true;
});
function mount(props = fixture()) {
  act(() => {
    renderer = create(<UiNextListenPanel {...props} />);
  });
  return { root: renderer!.root, props };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string | RegExp) {
  return root.find((node) => {
    if (node.type !== 'button') return false;
    const label = node.props['aria-label'] ?? text(node).trim();
    return typeof name === 'string' ? name === label : name.test(label);
  });
}
function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

describe('UiNextListenPanel playback', () => {
  it('places explicit regeneration after next and disables it while preparing', () => {
    const retryAudio = vi.fn();
    const props = fixture({
      playing: true,
      paused: true,
      retryAudio,
      retryAudioAvailable: true,
      hostedBusy: true,
      playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server' },
      plainVoices: { available: true, defaultVoiceId: 'voice', voices: [{ id: 'voice', label: 'Voice', lang: 'ko' }] },
    });
    const { root } = mount(props);
    const controls = root.findByProps({ className: 'un-listen-controls' });
    expect(controls.findAllByType('button').map((b) => b.props['aria-label'])).toEqual([
      '정지',
      '이전 문단',
      '계속 듣기',
      '다음 문단',
      '현재 음성 다시 생성',
    ]);
    expect(button(root, '현재 음성 다시 생성').props.disabled).toBeFalsy();
    click(button(root, '현재 음성 다시 생성'));
    expect(retryAudio).toHaveBeenCalledOnce();
    expect(props.resume).not.toHaveBeenCalled();
    act(() => renderer!.update(<UiNextListenPanel {...props} retryAudioBusy />));
    expect(button(renderer!.root, '음성 다시 만드는 중').props.disabled).toBe(true);
    act(() => renderer!.update(<UiNextListenPanel {...props} retryAudioAvailable={false} />));
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBe(true);
  });
  it('allows regenerating a paused real hosted playback while its operation is still busy', async () => {
    const catalog = {
      available: true,
      revision: 'v1',
      defaultVoiceId: 'voice',
      voices: [{ id: 'voice', label: 'Voice', lang: 'ko' }],
    };
    let completeSynthesis!: (blob: Blob) => void;
    const synthesize = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          completeSynthesis = resolve;
        }),
    );
    type PlainInput = Parameters<typeof usePlainTTS>[0];
    const client = {
      listPlainTTSVoices: async () => catalog,
      synthesizePlainTTS: synthesize,
    } as unknown as PlainInput['client'];
    let completeAudio: ((played: boolean) => void) | undefined;
    let audioPlaying: ((active: boolean) => void) | undefined;
    const audio = {
      get hasActivePlayback() {
        return Boolean(completeAudio);
      },
      playBlob: vi.fn(
        (_blob: Blob, _progress?: (fraction: number) => void, onPlaying?: (active: boolean) => void) =>
          new Promise<boolean>((resolve) => {
            completeAudio = resolve;
            audioPlaying = onPlaying;
            audioPlaying?.(true);
          }),
      ),
      stop: vi.fn(() => {
        completeAudio?.(false);
        completeAudio = undefined;
      }),
      pause: vi.fn(() => audioPlaying?.(false)),
      resume: vi.fn(async () => {
        audioPlaying?.(true);
        return true;
      }),
    };
    const systemTTS = { stop: vi.fn(), pause: vi.fn(), resume: vi.fn() } as unknown as PlainInput['systemTTS'];
    const owner = {};
    const settings = { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server' as const, mode: 'plain' as const };
    const paragraph = {
      id: 'p1',
      index: 1,
      chapterId: 'chapter',
      novelId: 'book',
      text: '현재 문단입니다.',
    } as Paragraph;
    const playable = buildPlainTTSBatch({
      paragraphs: [paragraph, { ...paragraph, id: 'p2', index: 2, text: '다음 문단입니다.' }],
      rate: 1,
    })!;
    let controller!: ReturnType<typeof useTTSExecutionController>;
    let plain!: ReturnType<typeof usePlainTTS>;
    const pending: Promise<boolean>[] = [];
    const onError = vi.fn();
    function Harness() {
      controller = useTTSExecutionController({
        systemTTS,
        audioSession: audio,
        sessionOwner: owner,
        bookId: 'book',
        chapterId: 'chapter',
      });
      plain = usePlainTTS({
        client,
        owner,
        enabled: true,
        settings,
        contentRevision: 'r1',
        chapterId: 'chapter',
        rules: [],
        controller,
        systemTTS,
        onError,
      });
      return (
        <UiNextListenPanel
          {...fixture({
            playbackSettings: settings,
            plainVoices: catalog,
            playing: controller.playing,
            paused: controller.paused,
            hostedBusy: controller.hostedBusy,
            paragraphIndex: controller.index ?? 0,
            pause: controller.pause,
            retryAudioAvailable: Boolean(plain.ready && plain.retryTarget() && !controller.playbackWaiting),
            retryAudio: () => {
              if (controller.playbackWaiting) return;
              controller.stopAll({ preserveSleepTimer: true });
              const session = controller.beginSession('book', 'chapter', 0)!;
              pending.push(plain.play(playable, paragraph, session, undefined, { prepared: () => {} }));
            },
          })}
        />
      );
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      const session = controller.beginSession('book', 'chapter', 0)!;
      pending.push(plain.play(playable, paragraph, session));
    });
    expect(onError.mock.calls).toEqual([]);
    expect(plain.ready).toBe(true);
    expect(controller.playbackWaiting).toBe(true);
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBe(true);
    act(() => controller.pause());
    expect(controller.playbackWaiting).toBe(true);
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBe(true);
    act(() => controller.resume());
    await act(async () => {
      completeSynthesis(new Blob(['original audio']));
    });
    expect(audio.playBlob).toHaveBeenCalledOnce();
    expect(controller.hostedBusy).toBe(true);
    expect(controller.playbackWaiting).toBe(false);
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBeFalsy();
    click(button(renderer!.root, '일시정지'));
    expect(controller.paused).toBe(true);
    expect(controller.hostedBusy).toBe(true);
    await act(async () => {
      click(button(renderer!.root, '현재 음성 다시 생성'));
    });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenLastCalledWith(
      'chapter',
      expect.objectContaining({ regenerate: true }),
      expect.any(AbortSignal),
    );
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBe(true);
    const replacement = new Blob(['replacement audio']);
    await act(async () => {
      completeSynthesis(replacement);
    });
    expect(audio.playBlob.mock.calls[1][0]).toBe(replacement);
    expect(controller.paused).toBe(false);
    expect(button(renderer!.root, '현재 음성 다시 생성').props.disabled).toBeFalsy();
    await act(async () => {
      controller.stopAll();
      await Promise.all(pending);
    });
  });
  it.each([
    [false, false, '재생', 'start'],
    [true, false, '일시정지', 'pause'],
    [true, true, '계속 듣기', 'resume'],
  ] as const)('routes playing=%s paused=%s to %s', (playing, paused, label, action) => {
    const { root, props } = mount(fixture({ playing, paused }));
    click(button(root, label));
    for (const key of ['start', 'pause', 'resume'] as const)
      expect(props[key]).toHaveBeenCalledTimes(key === action ? 1 : 0);
  });
  it('disables starting when playback is unavailable', () => {
    const { root, props } = mount(fixture({ unavailable: true }));
    expect(button(root, '재생').props.disabled).toBe(true);
    expect(props.start).not.toHaveBeenCalled();
  });
  it.each([0.8, 1, 1.2, 1.5, 1.8])('selects the %s speed chip', (speed) => {
    const { root, props } = mount();
    const chips = root.findByProps({ role: 'radiogroup', 'aria-label': '자주 쓰는 속도' });
    expect(button(chips, '1.0x').props['aria-checked']).toBe(true);
    click(button(chips, `${speed.toFixed(1)}x`));
    expect(props.changeSpeed).toHaveBeenCalledExactlyOnceWith(speed);
  });
  it.each([
    [1, '속도 높이기', 1.1],
    [1, '속도 낮추기', 0.9],
    [0.65, '속도 낮추기', 0.6],
    [1.75, '속도 높이기', 1.8],
  ] as const)('steps speed %s with %s to %s', (speed, label, next) => {
    const { root, props } = mount(fixture({ speed }));
    click(button(root, label));
    expect(props.changeSpeed).toHaveBeenCalledExactlyOnceWith(next);
  });
  it.each([
    [0.6, '속도 낮추기'],
    [1.8, '속도 높이기'],
  ] as const)('disables stepping past speed %s', (speed, label) => {
    const { root, props } = mount(fixture({ speed }));
    expect(button(root, label).props.disabled).toBe(true);
    expect(props.changeSpeed).not.toHaveBeenCalled();
  });
  it.each([
    ['끔', undefined],
    ['10분', 10],
    ['20분', 20],
    ['30분', 30],
    ['60분', 60],
    ['화 끝', 'end_of_chapter'],
  ] as const)('sets the %s sleep timer', (label, sleepTimerDefault) => {
    const { root, props } = mount(
      fixture({ playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, sleepTimerDefault } }),
    );
    const chips = root.findByProps({ role: 'radiogroup', 'aria-label': '기본 수면 타이머' });
    expect(button(chips, label).props['aria-checked']).toBe(true);
    click(button(chips, label));
    expect(props.changePlaybackSettings).toHaveBeenCalledExactlyOnceWith({ sleepTimerDefault });
  });
});

describe('UiNextListenPanel pages and status', () => {
  it('enters 세부 청취 설정 and returns to the player', () => {
    const { root } = mount();
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^세부 청취 설정/));
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('세부 청취 설정');
    expect(root.findAllByProps({ 'aria-label': '재생' })).toHaveLength(0);
    expect(root.findAllByType('h3').map(text)).toContain('쉬는 간격');
    click(button(root, '듣기'));
    expect(button(root, '재생')).toBeDefined();
  });
  it('keeps real-time cast out of the main page unless it is already in use', () => {
    const { root } = mount();
    expect(root.findAll((node) => node.props.label === '낭독 방식')).toHaveLength(0);
    const links = root.findByProps({ 'aria-label': '더 많은 청취 설정' }).findAllByType('button').map(text);
    expect(links.some((label) => /화자·고급|인물별 목소리/.test(label))).toBe(false);
    act(() => renderer!.update(<UiNextListenPanel {...fixture()} realtimeCastAvailable />));
    expect(root.find((node) => node.props.label === '낭독 방식').props.value).toBe('plain');
  });
  it('opens the real-time cast page from a saved cast choice', () => {
    const props = fixture({ playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, mode: 'cast' } });
    const { root } = mount(props);
    expect(root.find((node) => node.props.label === '낭독 방식').props.value).toBe('cast');
    click(button(root, /^인물별 목소리/));
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('실시간 인물별 낭독');
    const realtime = root.findByType(TTSAddonPanel);
    expect(realtime.props.view).toBe('advanced');
    expect(realtime.props.changePlaybackSettings).toBe(props.changePlaybackSettings);
    click(button(root, '듣기'));
    expect(root.findAllByType(TTSAddonPanel)).toHaveLength(0);
  });
  it('opens the filter preview for each new nonempty spoken preview request', () => {
    const props = fixture({ saveSpokenTextFilter: vi.fn(async () => undefined), currentParagraphText: '지금 문단' });
    const { root } = mount(props);
    act(() =>
      renderer!.update(<UiNextListenPanel {...props} spokenPreviewRequest={{ id: 1, text: '미리 읽을 문장' }} />),
    );
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('발음·문자 필터');
    expect(root.findByProps({ 'aria-label': '미리볼 원문' }).props.value).toBe('미리 읽을 문장');
    click(button(root, '듣기'));
    expect(button(root, '재생')).toBeDefined();
    act(() => renderer!.update(<UiNextListenPanel {...props} spokenPreviewRequest={{ id: 2, text: '다음 문장' }} />));
    expect(root.findByProps({ 'aria-label': '미리볼 원문' }).props.value).toBe('다음 문장');
    // Choosing the same sentence again after typing another one is still a new request.
    act(() => root.findByProps({ 'aria-label': '미리볼 원문' }).props.onChange({ target: { value: '직접 쓴 문장' } }));
    act(() => renderer!.update(<UiNextListenPanel {...props} spokenPreviewRequest={{ id: 3, text: '다음 문장' }} />));
    expect(root.findByProps({ 'aria-label': '미리볼 원문' }).props.value).toBe('다음 문장');
  });
  it('lists the earlier pronunciation dictionary on the filter page and removes from that store', () => {
    const rule = {
      id: 'legacy-1',
      sourceTerm: 'HP',
      replacement: '에이치피',
      mode: 'literal' as const,
      userConfirmed: true,
      provenance: 'user' as const,
      enabled: true,
    };
    const props = fixture({
      saveSpokenTextFilter: vi.fn(async () => undefined),
      voiceProductState: {
        pronunciationProfile: { id: 'p', novelId: 'n', revision: 1, revisionId: 'r', rules: [rule], updatedAt: '' },
      } as unknown as TTSAddonPanelProps['voiceProductState'],
    });
    const { root } = mount(props);
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^발음·문자 필터/));
    act(() => root.findByProps({ 'aria-label': '미리볼 원문' }).props.onChange({ target: { value: 'HP 회복' } }));
    expect(text(root.findByProps({ className: 'un-filter-result' }))).toContain('에이치피 회복');
    click(button(root, 'HP 발음 규칙 삭제'));
    expect(props.deletePronunciationRule).toHaveBeenCalledExactlyOnceWith('legacy-1');
    expect(props.deleteSpokenTextSkipRule).not.toHaveBeenCalled();
  });
  it('does not leave the player for a blank spoken preview request', () => {
    const { root } = mount(fixture({ spokenPreviewRequest: { id: 1, text: '   ' } }));
    expect(button(root, '재생')).toBeDefined();
    expect(root.findAllByType(TTSAddonPanel)).toHaveLength(0);
  });
  it.each(['warning', 'danger'])('renders %s status and refreshes it', (statusTone) => {
    const { root, props } = mount(
      fixture({
        statusTone,
        status: {
          supported: true,
          canSpeak: statusTone !== 'danger',
          voicesAvailable: false,
          voiceCount: 0,
          message: '음성 상태 안내',
        },
      }),
    );
    const status = root.findByProps({ role: 'status' });
    expect(text(status)).toContain('음성 상태 안내');
    expect(text(status)).toContain(statusTone === 'danger' ? '이 기기에서 TTS를 쓸 수 없어요' : '기본 음성으로 읽어요');
    expect(status.props.className.split(' ').includes('is-danger')).toBe(statusTone === 'danger');
    click(button(status, 'TTS 상태 새로고침'));
    expect(props.refreshStatus).toHaveBeenCalledExactlyOnceWith();
  });
  it('does not show a warning for ready status', () => {
    expect(mount().root.findAllByProps({ role: 'status' })).toHaveLength(0);
  });
});

describe('UiNextListenPanel plain engine voices', () => {
  const catalog = {
    available: true,
    revision: 'engines-r7',
    voices: [
      { id: 'M1', label: 'Supertonic M1', lang: 'ko', providerId: 'supertonic', providerName: 'Supertonic 3' },
      { id: 'F1', label: 'Supertonic F1', lang: 'ko', providerId: 'supertonic', providerName: 'Supertonic 3' },
      { id: 'gemini:Kore', label: 'Kore', lang: 'ko', providerId: 'gemini', paid: true },
      { id: 'other:Ann', label: 'Ann', lang: 'ko', providerId: 'other' },
    ],
    providers: [
      { id: 'supertonic', name: 'Supertonic 3', available: true, paid: false },
      { id: 'gemini', name: 'Gemini', modelId: 'gemini-tts-lite', available: true, paid: true },
      { id: 'other', name: 'Other TTS', available: false, paid: true, message: 'API 키 오류' },
    ],
  } as TTSAddonPanelProps['plainVoices'];
  const serverFixture = (serverVoiceId?: string, overrides: Partial<TTSAddonPanelProps> = {}) =>
    fixture({
      plainVoices: catalog,
      previewPlainVoice: vi.fn(),
      refreshPlainVoices: vi.fn(),
      playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, mode: 'plain', voiceSource: 'server', serverVoiceId },
      ...overrides,
    });
  const select = (root: ReactTestInstance) => root.findByProps({ 'aria-label': '서버 목소리' });

  it('groups voices by engine and saves the opaque voice id', () => {
    const { root, props } = mount(serverFixture('M1'));
    const groups = select(root).findAllByType('optgroup');
    expect(groups.map((group) => group.props.label)).toEqual(['Supertonic 3', 'Gemini · gemini-tts-lite', 'Other TTS']);
    expect(groups[1]!.findAllByType('option').map(text)).toEqual(['Kore · 유료 API']);
    expect(groups[2]!.findByType('option').props.disabled).toBe(true);
    act(() => select(root).props.onChange({ target: { value: 'gemini:Kore' } }));
    expect(props.changePlaybackSettings).toHaveBeenCalledExactlyOnceWith({ serverVoiceId: 'gemini:Kore' });
    expect(root.findAllByProps({ className: 'un-listen-note is-paid' })).toHaveLength(0);
    expect(text(root.findByProps({ 'aria-label': '연결 안 된 엔진' }))).toContain('Other TTS 연결 안 됨 · API 키 오류');
    expect(button(root, '재생').props.disabled).toBe(false);
  });
  it('warns that a paid external voice uses API quota while still allowing preview', () => {
    const { root, props } = mount(serverFixture('gemini:Kore'));
    expect(text(root.findByProps({ role: 'note' }))).toContain('Gemini API 사용량(요금)이 발생할 수 있어요');
    click(button(root, '목소리 미리듣기'));
    expect(props.previewPlainVoice).toHaveBeenCalledOnce();
  });
  it('blocks a voice whose engine is down without switching to another engine', () => {
    const { root, props } = mount(serverFixture('other:Ann'));
    expect(button(root, '재생').props.disabled).toBe(true);
    expect(button(root, '목소리 미리듣기').props.disabled).toBe(true);
    expect(root.findAllByType('p').map(text).join('\n')).toContain('Other TTS에 연결할 수 없어요 (API 키 오류)');
    expect(props.changePlaybackSettings).not.toHaveBeenCalled();
  });
  it('blocks the server default when the server has no default voice even if a paid engine is up', () => {
    const { root, props } = mount(
      serverFixture(undefined, { plainVoices: { ...catalog!, defaultVoiceId: '' } as never }),
    );
    expect(text(select(root).findAllByType('option')[0]!)).toBe('서버 기본 목소리 · 준비 안 됨');
    expect(button(root, '재생').props.disabled).toBe(true);
    expect(button(root, '목소리 미리듣기').props.disabled).toBe(true);
    expect(root.findAllByProps({ role: 'note' })).toHaveLength(0);
    expect(root.findAllByType('p').map(text).join('\n')).toContain('목소리를 직접 고르세요');
    expect(props.changePlaybackSettings).not.toHaveBeenCalled();
  });
  it('names the engine of the chosen voice even when only one engine is listed', () => {
    const single = {
      available: true,
      voices: [{ id: 'F1', label: '한국어 여성1', lang: 'ko', providerId: 'supertonic' }],
      providers: [{ id: 'supertonic', name: 'Supertonic 3', available: true, paid: false }],
    } as never;
    const { root } = mount(serverFixture('F1', { plainVoices: single }));
    expect(select(root).findAllByType('optgroup')).toHaveLength(0);
    expect(select(root).props.value).toBe('F1');
    expect(text(root.findByProps({ className: 'un-listen-engine-tag' }))).toBe('엔진 Supertonic 3');
  });
  const openDetails = (root: ReactTestInstance) =>
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^세부 청취 설정/));

  it('keeps synthesis units in the detail settings and switches sentence/paragraph', () => {
    const { root, props } = mount(serverFixture('M1'));
    expect(root.findAllByProps({ label: '합성 단위' })).toHaveLength(0);
    openDetails(root);
    const units = root.findByProps({ label: '합성 단위' });
    expect(units.props.value).toBe('sentence');
    act(() => units.props.onChange('paragraph'));
    expect(props.changePlaybackSettings).toHaveBeenCalledExactlyOnceWith({ plainChunking: 'paragraph' });
    act(() =>
      renderer!.update(
        <UiNextListenPanel {...props} playbackSettings={{ ...props.playbackSettings, plainChunking: 'paragraph' }} />,
      ),
    );
    expect(text(root.findByProps({ className: 'un-listen-hint' }))).toContain('700자');
  });
  it('offers batch synthesis in the detail settings only', () => {
    const { root, props } = mount(serverFixture('M1'));
    expect(text(root)).not.toContain('묶음');
    openDetails(root);
    const units = root.findByProps({ label: '합성 단위' });
    expect(units.props.options.map((option: { value: string }) => option.value)).toEqual([
      'sentence',
      'paragraph',
      'batch',
    ]);
    act(() => units.props.onChange('batch'));
    expect(props.changePlaybackSettings).toHaveBeenCalledExactlyOnceWith({ plainChunking: 'batch' });
    act(() =>
      renderer!.update(
        <UiNextListenPanel {...props} playbackSettings={{ ...props.playbackSettings, plainChunking: 'batch' }} />,
      ),
    );
    const hint = text(root.findByProps({ className: 'un-listen-hint' }));
    expect(hint).toContain('문단을 대략 따라가요');
    expect(hint).toContain('이어듣기는 묶음 첫 문단부터');
    expect(hint).toContain('쉬는 간격이 적용되지 않아요');
    const size = root.findByProps({ label: '묶음 크기' });
    expect(size.props.value).toBe(700);
    act(() => size.props.onChange(1200));
    expect(props.changePlaybackSettings).toHaveBeenLastCalledWith({ plainBatchCharacters: 1200 });
  });
  it('hides synthesis units for device voices', () => {
    const { root } = mount();
    openDetails(root);
    expect(root.findAllByProps({ label: '합성 단위' })).toHaveLength(0);
  });
  it('opens TTS engine settings without speaker analysis and reloads voices on return', () => {
    const { root, props } = mount(serverFixture('M1'));
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^TTS 엔진 연결/));
    expect(root.findByType(ProviderSettingsPanel).props.scope).toBe('tts_synthesis');
    expect(root.findAllByType(TTSAddonPanel)).toHaveLength(0);
    click(button(root, '듣기'));
    expect(props.refreshPlainVoices).toHaveBeenCalledOnce();
    expect(button(root, '재생')).toBeDefined();
  });
  it('lists saved TTS servers on the engines page only when the port is wired', () => {
    const port: TTSConnectionsPort = {
      list: vi.fn(() => new Promise<TTSConnection[]>(() => {})),
      probe: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    };
    const without = mount(serverFixture('M1'));
    click(button(without.root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^TTS 엔진 연결/));
    expect(without.root.findAllByType(UiNextTTSConnections)).toHaveLength(0);
    act(() => renderer!.unmount());
    const { root, props } = mount(serverFixture('M1', { ttsConnections: port, onTTSConnectionsChanged: vi.fn() }));
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^TTS 엔진 연결/));
    const panel = root.findByType(UiNextTTSConnections);
    expect(panel.props.port).toBe(port);
    expect(panel.props.onChanged).toBe(props.onTTSConnectionsChanged);
    expect(root.findByType(ProviderSettingsPanel)).toBeDefined();
  });
});

describe('UiNextListenPanel optional server narration', () => {
  const empty = {
    available: false,
    voices: [],
    providers: [],
    defaultVoiceId: '',
  } as TTSAddonPanelProps['plainVoices'];
  const onServer = (overrides: Partial<TTSAddonPanelProps> = {}) =>
    fixture({
      plainVoices: empty,
      refreshPlainVoices: vi.fn(),
      openServerSettings: vi.fn(),
      playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server', serverVoiceId: 'supertonic:F1' },
      ...overrides,
    });
  const setup = (root: ReactTestInstance) => root.findAllByProps({ 'aria-label': '서버 목소리 준비' });

  it('guides an administrator to install the voice without touching the saved choice', () => {
    access.managed = true;
    const { root, props } = mount(onServer());
    expect(text(setup(root)[0]!)).toContain('‘서버 낭독 음성’을 설치하거나 다시 켜면');
    expect(root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(root.findByProps({ 'aria-label': '서버 목소리' }).props.value).toBe('supertonic:F1');
    expect(button(root, '재생').props.disabled).toBe(true);
    click(button(root, '서버 설정 열기'));
    expect(props.openServerSettings).toHaveBeenCalledOnce();
    expect(props.changePlaybackSettings).not.toHaveBeenCalled();
    click(button(root, '다시 확인'));
    expect(props.refreshPlainVoices).toHaveBeenCalledOnce();
    click(button(root, '이 기기 목소리로 듣기'));
    expect(props.changePlaybackSettings).toHaveBeenCalledExactlyOnceWith({ voiceSource: 'system' });
  });
  it('blocks a missing Supertonic choice while a paid engine remains and points administrators to it', () => {
    access.managed = true;
    const paidOnly = {
      available: true,
      defaultVoiceId: '',
      voices: [{ id: 'gemini:Kore', label: 'Kore', lang: 'ko', providerId: 'gemini', paid: true }],
      providers: [{ id: 'gemini', name: 'Gemini', available: true, paid: true }],
    } as never;
    for (const serverVoiceId of ['F1', undefined]) {
      const { root, props } = mount(
        onServer({
          plainVoices: paidOnly,
          playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server', serverVoiceId },
        }),
      );
      expect(setup(root)).toHaveLength(0);
      expect(button(root, '재생').props.disabled).toBe(true);
      expect(root.findAllByProps({ className: 'un-listen-note is-paid' })).toHaveLength(0);
      click(button(root, '서버 설정 열기'));
      expect(props.openServerSettings).toHaveBeenCalledOnce();
      expect(props.changePlaybackSettings).not.toHaveBeenCalled();
      act(() => renderer?.unmount());
      renderer = undefined;
    }
  });
  it('does not send administrators to server settings for a paid voice that is simply chosen', () => {
    access.managed = true;
    const paidOnly = {
      available: true,
      defaultVoiceId: '',
      voices: [{ id: 'gemini:Kore', label: 'Kore', lang: 'ko', providerId: 'gemini', paid: true }],
      providers: [{ id: 'gemini', name: 'Gemini', available: true, paid: true }],
    } as never;
    const { root } = mount(
      onServer({
        plainVoices: paidOnly,
        playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server', serverVoiceId: 'gemini:Kore' },
      }),
    );
    expect(button(root, '재생').props.disabled).toBe(false);
    expect(root.findAll((node) => node.type === 'button' && text(node).includes('서버 설정 열기'))).toHaveLength(0);
  });
  it('tells members who can install it and offers no action they cannot take', () => {
    access.managed = true;
    access.manageServer = false;
    const { root } = mount(onServer());
    expect(text(setup(root)[0]!)).toContain('서버 관리자가 서버 낭독 음성을 설치하거나 다시 켜면');
    expect(root.findAll((node) => node.type === 'button' && text(node).includes('서버 설정 열기'))).toHaveLength(0);
    // A saved 서버 choice stays selectable so nothing is switched behind the listener's back.
    expect(root.findByProps({ label: '음성 사용' }).props.value).toBe('server');
  });
  it('hides the server choice from members while the server has no narration voice', () => {
    access.managed = true;
    access.manageServer = false;
    const { root } = mount(onServer({ playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS } }));
    expect(root.findAllByProps({ label: '음성 사용' })).toHaveLength(0);
    expect(setup(root)).toHaveLength(0);
    expect(root.findByProps({ 'aria-label': '기기 목소리' })).toBeTruthy();
  });
  it('keeps offering the server choice to administrators so they can find the install', () => {
    access.managed = true;
    const { root } = mount(onServer({ playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS } }));
    expect(root.findByProps({ label: '음성 사용' }).props.value).toBe('system');
    expect(setup(root)).toHaveLength(0);
  });
  it('tells administrators on the engine page that Supertonic is installed from server settings', () => {
    access.managed = true;
    const { root, props } = mount(onServer({ playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS } }));
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^TTS 엔진 연결/));
    expect(root.findAllByType('p').map(text).join('\n')).toContain(
      'Supertonic 서버 낭독 음성은 서버 설정의 추가 기능에서',
    );
    click(button(root, '서버 설정 열기'));
    expect(props.openServerSettings).toHaveBeenCalledOnce();
  });
  it('does not offer the install where server management is unavailable', () => {
    const { root } = mount(onServer());
    expect(text(setup(root)[0]!)).toContain('서버 관리자가');
    expect(root.findAll((node) => node.type === 'button' && text(node).includes('서버 설정 열기'))).toHaveLength(0);
  });
  it('points administrators to server settings when the installed local voice is down', () => {
    access.managed = true;
    const down = {
      available: false,
      voices: [{ id: 'F1', label: 'F1', lang: 'ko', providerId: 'supertonic' }],
      providers: [{ id: 'supertonic', name: 'Supertonic 3', available: false, paid: false }],
    } as never;
    const { root, props } = mount(
      onServer({
        plainVoices: down,
        playbackSettings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server', serverVoiceId: 'F1' },
      }),
    );
    expect(setup(root)).toHaveLength(0);
    click(button(root, '서버 설정 열기'));
    expect(props.openServerSettings).toHaveBeenCalledOnce();
    expect(props.changePlaybackSettings).not.toHaveBeenCalled();
  });
});

describe('UiNextListenPanel 화자별 미리 생성하기', () => {
  const speakerGeneration = (): TTSSpeakerGenerationControls => ({
    key: 'account-1:novel-1',
    port: {
      preferences: vi.fn(() => new Promise<never>(() => {})),
      savePreferences: vi.fn(),
      list: vi.fn(() => new Promise<never>(() => {})),
      estimate: vi.fn(),
      create: vi.fn(),
      control: vi.fn(),
      remove: vi.fn(),
    },
    engines: { list: vi.fn(() => new Promise<never>(() => {})), probe: vi.fn(), save: vi.fn(), remove: vi.fn() },
    chapters: [{ id: 'c1', title: '1화' }],
    currentChapterId: 'c1',
    rules: [],
    footnotePlayback: 'skip',
    listen: vi.fn(),
    refreshVoices: vi.fn(),
  });

  it('is offered only when wired, beside the ordinary 미리 생성하기', () => {
    const without = mount();
    expect(text(without.root.findByProps({ 'aria-label': '더 많은 청취 설정' }))).not.toContain('화자별 미리 생성하기');
    act(() => renderer!.unmount());
    const { root } = mount(fixture({ speakerGeneration: speakerGeneration() }));
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^화자별 미리 생성하기/));
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('화자별 미리 생성하기');
    expect(root.findByType(UiNextSpeakerGenerationPanel)).toBeDefined();
    click(button(root, '듣기'));
    expect(button(root, '재생')).toBeDefined();
  });

  it('opens analysis models over the page, keeping it mounted, and reloads its list on change', () => {
    const controls = speakerGeneration();
    const { root } = mount(fixture({ speakerGeneration: controls }));
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), /^화자별 미리 생성하기/));
    const panel = root.findByType(UiNextSpeakerGenerationPanel);
    act(() => panel.props.onManageEngines());
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('모델 연결');
    const editor = root.findByType(UiNextSpeakerEngines);
    expect(editor.props.port).toBe(controls.engines);
    expect(root.findByType(UiNextSpeakerGenerationPanel)).toBe(panel);
    act(() => editor.props.onChanged());
    expect(panel.props.enginesRevision).toBe(1);
    click(button(root, '화자별 미리 생성하기'));
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe('화자별 미리 생성하기');
    expect(root.findAllByType(UiNextSpeakerEngines)).toHaveLength(0);
  });
});
