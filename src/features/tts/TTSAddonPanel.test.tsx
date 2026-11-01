import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import TTSAddonPanel, { type TTSAddonPanelProps } from './TTSAddonPanel';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';

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

describe('advanced listening tools', () => {
  it('retries a partial offline job with its original nearby scope', () => {
    const warmup = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedWarmupDisabled={false}
        warmup={warmup}
        offlineDownloadJob={{
          id: 'download-1',
          bookId: 'book-1',
          contentRevisionId: 'revision-1',
          scope: { kind: 'chapter', chapterIds: ['chapter-1', 'chapter-2'] },
          state: 'partial',
          plannedItems: 10,
          readyItems: 8,
          failedItems: 2,
          byteSize: 1_024,
          policy: { network: 'any', charging: 'any', retryLimit: 3, retainUntil: 'space_needed' },
          updatedAt: '2026-08-01T00:00:00.000Z',
        }}
      />,
    );
    act(() => renderer.root.findByProps({ 'aria-label': '실패한 오프라인 음성 다시 준비' }).props.onClick());
    expect(warmup).toHaveBeenCalledWith('nearby');
  });

  it('changes Android headless recovery constraints without delaying foreground work', () => {
    const changeOfflineDownloadPolicy = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        offlineDownloadPolicy={{ network: 'unmetered', charging: 'any' }}
        changeOfflineDownloadPolicy={changeOfflineDownloadPolicy}
      />,
    );
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': '무제한 네트워크에서만 백그라운드 재개' })
        .props.onChange({ target: { checked: false } }),
    );
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': '충전 중에만 백그라운드 재개' })
        .props.onChange({ target: { checked: true } }),
    );
    expect(changeOfflineDownloadPolicy).toHaveBeenNthCalledWith(1, { network: 'any' });
    expect(changeOfflineDownloadPolicy).toHaveBeenNthCalledWith(2, { charging: 'required' });
  });

  it('requests browser storage protection only from the explicit user action', () => {
    const requestHostedOfflineStorage = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedOfflineCacheStatus={{
          itemCount: 3,
          byteSize: 4_096,
          staleItemCount: 0,
          staleByteSize: 0,
          protectedStaleItemCount: 0,
          originUsage: 8_192,
          originQuota: 16_384,
          persisted: false,
          persistenceSupported: true,
        }}
        requestHostedOfflineStorage={requestHostedOfflineStorage}
      />,
    );
    expect(requestHostedOfflineStorage).not.toHaveBeenCalled();
    act(() => renderer.root.findByProps({ 'aria-label': '오프라인 음성 저장소 보호 요청' }).props.onClick());
    expect(requestHostedOfflineStorage).toHaveBeenCalledOnce();
  });

  it('cleans only cache reported as belonging to an older content revision', () => {
    const removeStaleHostedOfflineAudio = vi.fn();
    const renderer = create(
      <TTSAddonPanel
        {...props()}
        hostedOfflineCacheStatus={{
          itemCount: 5,
          byteSize: 12_288,
          staleItemCount: 2,
          staleByteSize: 4_096,
          protectedStaleItemCount: 1,
          persisted: true,
          persistenceSupported: true,
        }}
        removeStaleHostedOfflineAudio={removeStaleHostedOfflineAudio}
      />,
    );
    act(() => renderer.root.findByProps({ 'aria-label': '이전 본문 버전의 오프라인 음성 정리' }).props.onClick());
    expect(removeStaleHostedOfflineAudio).toHaveBeenCalledOnce();
    expect(
      renderer.root
        .findAllByType('small')
        .some((node) => node.children.join('') === '수동 보관 중인 이전 음성 1개는 유지됩니다.'),
    ).toBe(true);
  });

  it('lets the user pin discovered shared voices without leaving advanced TTS settings', () => {
    const saveVoicePool = vi.fn();
    const base = props();
    const profiles = ['pool-a', 'pool-b'].map((id, index) => ({
      id,
      novelId: 'book-1',
      role: 'character' as const,
      providerId: 'system',
      providerVoiceId: `voice-${index + 1}`,
      label: `Pool ${index + 1}`,
      speed: 1,
      isUserSelected: false,
    }));
    const renderer = create(
      <TTSAddonPanel
        {...base}
        voiceProfiles={profiles}
        voicePoolViews={{
          system: {
            providerId: 'system',
            userPinned: false,
            options: profiles.map((profile) => ({
              profile,
              voice: { id: profile.providerVoiceId, label: profile.label, lang: 'ko-KR' },
              selected: true,
            })),
          },
        }}
        saveVoicePool={saveVoicePool}
      />,
    );
    const poolOptions = renderer.root.findAllByProps({ className: 'voice-pool-option' });

    expect(poolOptions).toHaveLength(2);
    act(() => poolOptions[0]!.findByType('input').props.onChange());
    expect(saveVoicePool).toHaveBeenCalledWith('system', ['pool-b'], true);
  });

  it('shows that synced voice settings need a fresh assignment before playback', () => {
    const renderer = create(
      <TTSAddonPanel {...props()} voiceCastingSummary={{ assigned: 3, reviews: 0, unresolved: 0, stale: true }} />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain('설정 변경 후 재배정 필요');
  });
});
