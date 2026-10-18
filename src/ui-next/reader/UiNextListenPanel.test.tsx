import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProviderSettingsPanel from '../../features/providers/ProviderSettingsPanel';
import TTSAddonPanel, { type TTSAddonPanelProps } from '../../features/tts/TTSAddonPanel';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import UiNextListenPanel from './UiNextListenPanel';

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
  it.each(['세부 청취 설정', '화자·고급 설정'])('enters %s and returns to the player', (label) => {
    const { root, props } = mount();
    click(button(root.findByProps({ 'aria-label': '더 많은 청취 설정' }), new RegExp(`^${label}`)));
    expect(text(root.findByProps({ className: 'un-listen-page-title' }))).toBe(label);
    expect(root.findAllByProps({ 'aria-label': '재생' })).toHaveLength(0);
    if (label === '화자·고급 설정') {
      const advanced = root.findByType(TTSAddonPanel);
      expect(advanced.props.view).toBe('advanced');
      expect(advanced.props.changePlaybackSettings).toBe(props.changePlaybackSettings);
    } else expect(root.findAllByType('h3').map(text)).toContain('쉬는 간격');
    click(button(root, '듣기'));
    expect(button(root, '재생')).toBeDefined();
    expect(root.findAllByType(TTSAddonPanel)).toHaveLength(0);
  });
  it('opens the advanced page for each new nonempty spoken preview request', () => {
    const { root, props } = mount();
    const request = { id: 1, text: '미리 읽을 문장' };
    act(() => renderer!.update(<UiNextListenPanel {...props} spokenPreviewRequest={request} />));
    expect(root.findByType(TTSAddonPanel).props.spokenPreviewRequest).toBe(request);
    expect(root.findByProps({ 'aria-label': '읽기 미리보기 원문' }).props.value).toBe(request.text);
    click(button(root, '듣기'));
    expect(button(root, '재생')).toBeDefined();
    act(() => renderer!.update(<UiNextListenPanel {...props} spokenPreviewRequest={{ id: 2, text: '다음 문장' }} />));
    expect(root.findByProps({ 'aria-label': '읽기 미리보기 원문' }).props.value).toBe('다음 문장');
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
});
