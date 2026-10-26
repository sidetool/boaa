import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { usePlainTTS } from './usePlainTTS';
import { buildPlainTTSBatch } from '../../providers/plain-tts';
import { ttsQueueItemFingerprint } from '../../providers/tts-playback-resume';
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
  expect(hook.retryTarget()).toEqual({ index: 0, fingerprint: ttsQueueItemFingerprint(playable) });
  const prepared = vi.fn();
  let retry!: Promise<boolean>;
  await act(async () => {
    retry = hook.play(playable, paragraphs[0], 3, undefined, { prepared });
    await Promise.resolve();
  });
  expect(prepared).not.toHaveBeenCalled();
  expect(synthesize).toHaveBeenCalledTimes(2);
  expect(synthesize).toHaveBeenLastCalledWith(
    'c',
    expect.objectContaining({ regenerate: true }),
    expect.any(AbortSignal),
  );
  const replacement = new Blob(['regenerated']);
  await act(async () => {
    resolve(replacement);
    expect(await retry).toBe(true);
  });
  expect(prepared).toHaveBeenCalled();
  expect(playAudio).toHaveBeenLastCalledWith(replacement, 3, undefined);
  await act(async () => {
    await hook.play(playable, paragraphs[0], 4);
  });
  expect(synthesize).toHaveBeenCalledTimes(2);
  expect(playAudio).toHaveBeenLastCalledWith(replacement, 4, undefined);
  synthesize.mockRejectedValueOnce(new Error('regeneration failed'));
  const playedBeforeFailure = playAudio.mock.calls.length;
  await act(async () => {
    expect(await hook.play(playable, paragraphs[0], 5, undefined, { prepared })).toBe(false);
  });
  expect(playAudio).toHaveBeenCalledTimes(playedBeforeFailure);
  expect(hook.retryTarget()).toEqual({ index: 0, fingerprint: ttsQueueItemFingerprint(playable) });
  voice = 'another';
  await act(async () => {
    root.update(<Harness rate={1.8} />);
  });
  expect(hook.reusableStart(2)).toBe(2);
  expect(hook.retryTarget()).toBeUndefined();
  voice = 'voice';
  owner = {};
  await act(async () => {
    root.update(<Harness rate={1.8} />);
  });
  expect(hook.reusableStart(2)).toBe(2);
  expect(hook.retryTarget()).toBeUndefined();
  act(() => root.unmount());
});

it.each(['recover', 'cancel', 'non-retryable'] as const)(
  'handles a foreground listener joining failed prefetch: %s',
  async (scenario) => {
    vi.useFakeTimers();
    let root: ReactTestRenderer | undefined;
    try {
      let reject!: (error: unknown) => void;
      const synthesize = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Blob>((_, fail) => {
              reject = fail;
            }),
        )
        .mockResolvedValue(new Blob(['audio']));
      const abort = new AbortController();
      const playAudio = vi.fn(async () => true);
      const setHostedStatus = vi.fn();
      const onError = vi.fn();
      const client = {
        listPlainTTSVoices: async () => ({
          available: true,
          revision: 'v1',
          voices: [{ id: 'voice', label: 'Voice', lang: 'ko' }],
        }),
        synthesizePlainTTS: synthesize,
      } as unknown as Input['client'];
      const controller = {
        beginHostedPlayback: () => ({ controller: abort }),
        isSessionCurrent: () => !abort.signal.aborted,
        setHostedStatus,
        playAudio,
        finishOperation: vi.fn(),
        stopAll: vi.fn(),
      } as unknown as Input['controller'];
      const paragraph = { id: 'p', index: 1, chapterId: 'c', novelId: 'b', text: '테스트 문단입니다.' } as Paragraph;
      const playable = buildPlainTTSBatch({ paragraphs: [paragraph, { ...paragraph, id: 'p2', index: 2 }], rate: 1 })!;
      let hook!: ReturnType<typeof usePlainTTS>;
      function Harness() {
        hook = usePlainTTS({
          client,
          enabled: true,
          controller,
          settings: {
            ...DEFAULT_TTS_PLAYBACK_SETTINGS,
            mode: 'plain',
            voiceSource: 'server',
            serverVoiceId: 'voice',
            plainChunking: 'batch',
          },
          contentRevision: 'r',
          chapterId: 'c',
          rules: [],
          onError,
          systemTTS: { stop: vi.fn() } as unknown as Input['systemTTS'],
        });
        return null;
      }
      await act(async () => {
        root = create(<Harness />);
      });
      let prefetch!: Promise<void>;
      let play!: Promise<boolean>;
      await act(async () => {
        prefetch = hook.prefetch(playable, paragraph, 1);
      });
      await act(async () => {
        play = hook.play(playable, paragraph, 1);
      });
      expect(synthesize).toHaveBeenCalledOnce();
      await act(async () => {
        reject(
          Object.assign(new Error('fixture failure'), {
            status: scenario === 'non-retryable' ? 502 : 429,
            payload: { retryAfterSeconds: 1 },
          }),
        );
        await prefetch;
      });
      if (scenario === 'cancel') abort.abort();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await play).toBe(scenario === 'recover');
      });
      expect(synthesize).toHaveBeenCalledTimes(scenario === 'recover' ? 2 : 1);
      expect(playAudio).toHaveBeenCalledTimes(scenario === 'recover' ? 1 : 0);
      if (scenario !== 'non-retryable')
        expect(setHostedStatus).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('1초 후'));
      if (scenario === 'recover') expect(onError).not.toHaveBeenCalled();
    } finally {
      if (root) act(() => root!.unmount());
      vi.useRealTimers();
    }
  },
);
