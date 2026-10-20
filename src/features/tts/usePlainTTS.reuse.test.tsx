import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { usePlainTTS } from './usePlainTTS';
import { buildPlainTTSBatch } from '../../providers/plain-tts';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import type { Paragraph } from '../../domain/types';

type Input = Parameters<typeof usePlainTTS>[0];
it('joins prefetch, replays without synthesis after speed changes and navigates known batch boundaries', async () => {
  let resolve!: (blob: Blob) => void;
  const synthesize = vi.fn(
    () =>
      new Promise<Blob>((done) => {
        resolve = done;
      }),
  );
  const client = {
    listPlainTTSVoices: async () => ({
      available: true,
      revision: 'v1',
      defaultVoiceId: 'voice',
      voices: [{ id: 'voice', label: 'Voice', lang: 'ko' }],
    }),
    synthesizePlainTTS: synthesize,
  } as unknown as Input['client'];
  const playAudio = vi.fn(async (_blob: Blob) => true);
  const controller = {
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio,
    finishOperation: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as Input['controller'];
  const paragraphs = [0, 1, 2].map(
    (index) =>
      ({ id: `p${index}`, index: index + 1, chapterId: 'c', novelId: 'b', text: `문단 ${index}입니다.` }) as Paragraph,
  );
  const playable = buildPlainTTSBatch({ paragraphs, rate: 1 })!;
  let hook!: ReturnType<typeof usePlainTTS>;
  let owner = {};
  let voice = 'voice';
  function Harness({ rate }: { rate: number }) {
    hook = usePlainTTS({
      client,
      owner,
      enabled: true,
      settings: {
        ...DEFAULT_TTS_PLAYBACK_SETTINGS,
        mode: 'plain',
        voiceSource: 'server',
        serverVoiceId: voice,
        plainChunking: 'batch',
        rate,
      },
      contentRevision: 'r1',
      chapterId: 'c',
      rules: [],
      controller,
      systemTTS: { stop: vi.fn() } as unknown as Input['systemTTS'],
      onError: vi.fn(),
    });
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness rate={1} />);
  });
  let prefetch!: Promise<void>;
  act(() => {
    prefetch = hook.prefetch(playable, paragraphs[0], 1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.reusableStart(2)).toBe(0);
  expect(hook.jumpIndex(1, 1)).toBe(3);
  expect(hook.jumpIndex(1, -1)).toBe(0);
  let play!: Promise<boolean>;
  act(() => {
    play = hook.play(playable, paragraphs[0], 1);
  });
  await act(async () => {
    root.update(<Harness rate={1.8} />);
  });
  const blob = new Blob(['prepared audio']);
  await act(async () => {
    resolve(blob);
    await prefetch;
    await play;
  });
  await act(async () => {
    await hook.play({ ...playable, rate: 1.8 }, paragraphs[0], 2);
  });
  expect(synthesize).toHaveBeenCalledOnce();
  expect(synthesize).toHaveBeenCalledWith('c', expect.objectContaining({ rate: 1 }), expect.any(AbortSignal));
  expect(playAudio).toHaveBeenCalledTimes(2);
  expect(playAudio.mock.calls[0][0]).toBe(blob);
  voice = 'another';
  await act(async () => {
    root.update(<Harness rate={1.8} />);
  });
  expect(hook.reusableStart(2)).toBe(2);
  voice = 'voice';
  owner = {};
  await act(async () => {
    root.update(<Harness rate={1.8} />);
  });
  expect(hook.reusableStart(2)).toBe(2);
  act(() => root.unmount());
});
