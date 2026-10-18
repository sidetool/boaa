import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { usePlainTTS } from './usePlainTTS';
import { buildPlainTTSItems } from '../../providers/plain-tts';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import type { Paragraph } from '../../domain/types';
it('uses the live revision for unchanged current text even inside an already-running playback closure', async () => {
  type Input = Parameters<typeof usePlainTTS>[0];
  const synthesize = vi.fn(async () => new Blob(['audio']));
  const client = {
    listPlainTTSVoices: async () => ({
      available: true,
      revision: 'model',
      defaultVoiceId: 'v',
      voices: [{ id: 'v', label: 'Voice', lang: 'ko' }],
    }),
    synthesizePlainTTS: synthesize,
  } as unknown as Input['client'];
  const controller = {
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    takePrefetched: () => undefined,
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio: async () => true,
    finishOperation: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as Input['controller'];
  const paragraph = { id: 'p', index: 1, chapterId: 'c', novelId: 'b', text: '이 문장은 그대로입니다.' } as Paragraph;
  const playable = buildPlainTTSItems({ paragraph, language: 'ko', rate: 1 })[0];
  let hook!: ReturnType<typeof usePlainTTS>;
  function Harness({ revision }: { revision: string }) {
    hook = usePlainTTS({
      client,
      enabled: true,
      settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server' },
      contentRevision: revision,
      chapterId: 'c',
      rules: [],
      controller,
      systemTTS: { stop: vi.fn() } as unknown as Input['systemTTS'],
      onError: vi.fn(),
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness revision="before-append" />);
  });
  const existingPlayback = hook.play;
  await act(async () => {
    root.update(<Harness revision="after-append" />);
  });
  await act(async () => {
    await existingPlayback(playable, paragraph, 1);
  });
  expect(synthesize).toHaveBeenCalledWith(
    'c',
    expect.objectContaining({ contentRevision: 'after-append' }),
    expect.any(AbortSignal),
  );
  act(() => root.unmount());
});
