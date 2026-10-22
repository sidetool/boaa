import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { TTSAddonPanelProps } from './TTSAddonPanel';
import TTSAddonPanel from '../../ui-next/reader/UiNextListenPanel';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import { Segmented, Switch } from '../../ui-next/components/primitives';

function labeledSelect(root: ReactTestInstance, label: string) {
  if (label === '낭독 방식' || label === '음성 사용')
    return root.findAllByType(Segmented).find((node) => node.props.label === label)!;
  return root.findByProps({ 'aria-label': label });
}
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function labeledButton(root: ReactTestInstance, label: string) {
  const found = root
    .findAllByType('button')
    .find((node) => node.props['aria-label'] === label || text(node).trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function props(): TTSAddonPanelProps {
  const action = vi.fn();
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
    playbackSettings: DEFAULT_TTS_PLAYBACK_SETTINGS,
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
      updateDraft: action,
      updateSecretDraft: action,
      refresh: action,
      saveSettings: action,
      saveSecret: action,
      deleteSecret: action,
      testSecret: action,
      runDesktopLLMSample: action,
      playDesktopTTSSample: action,
    },
    voiceProductBusy: false,
    voiceProductSummary: { major: 0, approved: 0, stale: 0 },
    spokenTextRules: [],
    voicePoolViews: {},
    bookCharacterCount: 0,
    refreshStatus: action,
    jump: action,
    start: action,
    resume: action,
    pause: action,
    stop: action,
    changeSpeed: action,
    changePlaybackSettings: action,
    setBookOverrideEnabled: action,
    resetBookOverride: action,
    resumeSavedPlayback: action,
    changeSystemVoice: action,
    saveSystemVoice: action,
    saveHostedVoice: action,
    saveHostedVoiceOption: action,
    refreshHostedVoices: action,
    warmup: action,
    changeOfflineDownloadPolicy: action,
    requestHostedOfflineStorage: action,
    removeStaleHostedOfflineAudio: action,
    generateVoiceDraft: action,
    saveVoicePool: action,
    playVoiceSample: action,
    decideVoice: action,
    savePronunciationRule: action,
    deletePronunciationRule: action,
    saveSpokenTextSkipRule: action,
    deleteSpokenTextSkipRule: action,
    previewSpokenTextRuleImpact: async () => ({
      scannedParagraphCount: 0,
      affectedParagraphCount: 0,
      fullySkippedParagraphCount: 0,
      skippedRangeCount: 0,
      samples: [],
    }),
    setMinorFallbackEnabled: action,
    setMajorCharacterLimit: action,
  };
}

describe('listening controls', () => {
  it('defaults to device narration and keeps advanced adjustments collapsed', () => {
    const base = props();
    const changePlaybackSettings = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...base}
        playbackSettings={{ ...base.playbackSettings, mode: undefined, voiceSource: undefined }}
        changePlaybackSettings={changePlaybackSettings}
      />,
    );
    const panel = renderer.root;

    expect(labeledSelect(panel, '낭독 방식').props.value).toBe('plain');
    expect(labeledSelect(panel, '음성 사용').props.value).toBe('system');
    expect(labeledButton(panel, '재생').props.disabled).toBe(false);
    expect(panel.findByProps({ 'aria-label': '기본 수면 타이머' })).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('바꾼 설정은 모든 작품의 기본값이 돼요.');
    expect(changePlaybackSettings).not.toHaveBeenCalled();

    act(() => labeledSelect(panel, '낭독 방식').props.onChange('cast'));
    act(() => labeledSelect(panel, '음성 사용').props.onChange('server'));
    expect(changePlaybackSettings).toHaveBeenNthCalledWith(1, { mode: 'cast' });
    expect(changePlaybackSettings).toHaveBeenNthCalledWith(2, { voiceSource: 'server' });
  });

  it('selects or clears the device voice without duplicate controls', async () => {
    const changeSystemVoice = vi.fn();
    const previewPlainVoice = vi.fn(async () => undefined);
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        voices={[{ id: 'device-a', label: 'Device A', lang: 'ko-KR' }]}
        selectedSystemVoiceId="device-a"
        changeSystemVoice={changeSystemVoice}
        previewPlainVoice={previewPlainVoice}
      />,
    );
    const panel = renderer.root;
    const voice = labeledSelect(panel, '기기 목소리');
    expect(voice.props.value).toBe('device-a');
    act(() => voice.props.onChange({ target: { value: '' } }));
    act(() => voice.props.onChange({ target: { value: 'device-a' } }));
    expect(changeSystemVoice).toHaveBeenNthCalledWith(1, undefined);
    expect(changeSystemVoice).toHaveBeenNthCalledWith(2, 'device-a');

    await act(async () => labeledButton(panel, '목소리 미리듣기').props.onClick());
    expect(previewPlainVoice).toHaveBeenCalledOnce();
  });

  it('uses server voice controls without requiring device voices or cast profiles', async () => {
    const base = props();
    const changePlaybackSettings = vi.fn();
    const refreshPlainVoices = vi.fn();
    const previewPlainVoice = vi.fn(async () => undefined);
    const renderer = create(
      <TTSAddonPanel
        {...base}
        unavailable
        statusTone="danger"
        status={{
          supported: false,
          canSpeak: false,
          voicesAvailable: false,
          voiceCount: 0,
          message: 'Device unavailable',
        }}
        playbackSettings={{ ...base.playbackSettings, mode: 'plain', voiceSource: 'server', serverVoiceId: 'server-b' }}
        plainVoices={{
          available: true,
          revision: 'model-1',
          voices: [
            { id: 'server-a', label: 'Server A', lang: 'ko-KR' },
            { id: 'server-b', label: 'Server B', lang: 'ko-KR' },
          ],
        }}
        changePlaybackSettings={changePlaybackSettings}
        refreshPlainVoices={refreshPlainVoices}
        previewPlainVoice={previewPlainVoice}
      />,
    );
    const panel = renderer.root;
    const voice = labeledSelect(panel, '서버 목소리');
    expect(voice.props.value).toBe('server-b');
    expect(voice.props.disabled).toBe(false);
    expect(labeledButton(panel, '재생').props.disabled).toBe(false);
    expect(panel.findByProps({ 'aria-label': '속도 높이기' }).props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Device unavailable');
    expect(changePlaybackSettings).not.toHaveBeenCalled();

    act(() => voice.props.onChange({ target: { value: 'server-a' } }));
    act(() => voice.props.onChange({ target: { value: '' } }));
    expect(changePlaybackSettings).toHaveBeenNthCalledWith(1, { serverVoiceId: 'server-a' });
    expect(changePlaybackSettings).toHaveBeenNthCalledWith(2, { serverVoiceId: '' });
    act(() => labeledButton(panel, '새로고침').props.onClick());
    expect(refreshPlainVoices).toHaveBeenCalledOnce();
    await act(async () => labeledButton(panel, '목소리 미리듣기').props.onClick());
    expect(previewPlainVoice).toHaveBeenCalledOnce();
  });

  it('preserves a missing saved server voice and blocks playback instead of switching voices', () => {
    const base = props();
    const changePlaybackSettings = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...base}
        playbackSettings={{
          ...base.playbackSettings,
          mode: 'plain',
          voiceSource: 'server',
          serverVoiceId: 'removed-voice',
        }}
        plainVoices={{ available: true, voices: [{ id: 'other-voice', label: 'Other voice', lang: 'ko-KR' }] }}
        previewPlainVoice={async () => undefined}
        changePlaybackSettings={changePlaybackSettings}
      />,
    );
    const panel = renderer.root;
    expect(labeledSelect(panel, '서버 목소리').props.value).toBe('removed-voice');
    expect(
      labeledSelect(panel, '서버 목소리')
        .findAllByType('option')
        .some((option) => option.props.value === 'removed-voice'),
    ).toBe(true);
    expect(labeledButton(panel, '재생').props.disabled).toBe(true);
    expect(labeledButton(panel, '목소리 미리듣기').props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('저장된 목소리를 찾을 수 없습니다.');
    expect(changePlaybackSettings).not.toHaveBeenCalled();
  });

  it('reports unavailable server voices while keeping the offline setting recoverable', () => {
    const base = props();
    const changePlaybackSettings = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...base}
        playbackSettings={{ ...base.playbackSettings, mode: 'plain', voiceSource: 'server', offlineOnly: true }}
        plainVoices={{ available: false, voices: [], message: 'Voice server is unavailable' }}
        previewPlainVoice={async () => undefined}
        changePlaybackSettings={changePlaybackSettings}
      />,
    );
    const panel = renderer.root;
    expect(labeledSelect(panel, '서버 목소리').props.disabled).toBe(true);
    expect(labeledButton(panel, '재생').props.disabled).toBe(true);
    expect(labeledButton(panel, '목소리 미리듣기').props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Voice server is unavailable');
    act(() =>
      panel
        .findAllByType('button')
        .find((node) => node.findAllByType('b').some((label) => text(label) === '세부 청취 설정'))!
        .props.onClick(),
    );
    const offline = renderer.root.findAllByType(Switch).find((node) => node.props.label === '준비된 음성만 사용')!;
    expect(offline.props.checked).toBe(true);
    act(() => offline.props.onChange(false));
    expect(changePlaybackSettings).toHaveBeenCalledWith({ offlineOnly: false });
  });

  it('disables preview while busy and describes book-specific saving', () => {
    const renderer = create(
      <TTSAddonPanel {...props()} bookOverrideEnabled plainPreviewBusy previewPlainVoice={async () => undefined} />,
    );
    const panel = renderer.root;
    const preview = labeledButton(panel, '목소리 미리듣기');
    expect(preview.props.disabled).toBe(true);
    expect(preview.props['aria-busy']).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('바꾼 설정은 이 작품에만 저장돼요.');
  });

  it('preserves cast playback and advanced character voice controls', () => {
    const base = props();
    const renderer = create(
      <TTSAddonPanel
        {...base}
        unavailable
        hostedPlaybackReady
        playbackSettings={{ ...base.playbackSettings, mode: 'cast' }}
      />,
    );
    const panel = renderer.root;
    expect(labeledSelect(panel, '낭독 방식').props.value).toBe('cast');
    expect(labeledButton(panel, '재생').props.disabled).toBe(false);
    act(() => labeledButton(panel, '화자·고급 설정인물별 목소리, 발음 사전, 읽기 미리보기').props.onClick());
    const advanced = renderer.root.findByProps({ id: 'tts-advanced-panel' });
    expect(advanced.props.hidden).toBe(false);
    expect(advanced.findAllByType('h4').map((node) => node.children.join(''))).toEqual(
      expect.arrayContaining(['캐릭터별 음성', '음성 초안과 승인', '서버 캐릭터 음성']),
    );
  });
});
