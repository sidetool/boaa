import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { usePlainTTS } from './usePlainTTS';
import { buildPlainTTSBatch, buildPlainTTSItems } from '../../providers/plain-tts';
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

it.each(['recover', 'cancel', 'non-retryable', 'repeated-429', 'exhausted-429'] as const)(
  'handles a foreground listener joining failed prefetch: %s',
  async (scenario) => {
    vi.useFakeTimers();
    let root: ReactTestRenderer | undefined;
    try {
      let reject!: (error: unknown) => void;
      const synthesize = vi
        .fn()
        .mockImplementationOnce(
          (_chapter: string | undefined, _request: unknown, _signal?: AbortSignal) =>
            new Promise<Blob>((_, fail) => {
              reject = fail;
            }),
        )
        .mockResolvedValue(new Blob(['audio']));
      const repeated = scenario === 'repeated-429' || scenario === 'exhausted-429';
      if (repeated) {
        synthesize.mockRejectedValueOnce({ status: 429 }).mockRejectedValueOnce({ status: 429 });
        if (scenario === 'exhausted-429') synthesize.mockRejectedValueOnce({ status: 429 });
      }
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
            ...(repeated ? {} : { payload: { retryAfterSeconds: 1 } }),
          }),
        );
        await prefetch;
      });
      if (scenario === 'cancel') abort.abort();
      const success = scenario === 'recover' || scenario === 'repeated-429';
      if (repeated) {
        for (const [index, seconds] of [10, 20, 40].entries()) {
          expect(synthesize).toHaveBeenCalledTimes(index + 1);
          expect(playAudio).not.toHaveBeenCalled();
          expect(onError).not.toHaveBeenCalled();
          expect(setHostedStatus).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.stringContaining(`${seconds}초 후`),
          );
          await act(async () => {
            await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
          });
          expect(synthesize).toHaveBeenCalledTimes(index + 1);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
        }
      } else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(await play).toBe(success);
      expect(synthesize).toHaveBeenCalledTimes(repeated ? 4 : scenario === 'recover' ? 2 : 1);
      expect(playAudio).toHaveBeenCalledTimes(success ? 1 : 0);
      // Every retry retains exactly the same chapter, text identity and voice; it never skips ahead.
      for (const call of synthesize.mock.calls) expect(call.slice(0, 2)).toEqual(synthesize.mock.calls[0].slice(0, 2));
      if (scenario === 'recover' || scenario === 'cancel')
        expect(setHostedStatus).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('1초 후'));
      if (success || scenario === 'cancel') expect(onError).not.toHaveBeenCalled();
      if (scenario === 'exhausted-429') {
        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('자동 재시도를 멈췄습니다'));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        expect(synthesize).toHaveBeenCalledTimes(4);
      }
    } finally {
      if (root) act(() => root!.unmount());
      vi.useRealTimers();
    }
  },
);

it('uses prepared items with the normal audio controller despite different current settings or an offline model', async () => {
  const ordinary = vi.fn();
  const client = {
    listPlainTTSVoices: async () => ({ available: false, voices: [], revision: 'changed-catalog' }),
    synthesizePlainTTS: ordinary,
  } as unknown as Input['client'];
  const resolve = vi.fn(async () => new Blob(['recorded']));
  const audio = vi.fn(async () => new Blob(['saved']));
  const port = { resolve, audio } as unknown as NonNullable<Input['prepared']>;
  const progress = vi.fn();
  const playAudio = vi.fn(async (_blob: Blob, _session: number, update?: (fraction: number) => void) => {
    update?.(0.7);
    return true;
  });
  const controller = {
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio,
    finishOperation: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as Input['controller'];
  const paragraph = { id: 'p', index: 1, chapterId: 'c', novelId: 'b', text: '이미 만든 문장입니다.' } as Paragraph;
  const playable = {
    ...buildPlainTTSItems({ paragraph, rate: 1, chunking: 'sentence' })[0],
    preparedAudio: { id: 'job', ordinal: 3, ready: true },
  };
  let hook!: ReturnType<typeof usePlainTTS>;
  let owner = {};
  const systemTTS = { stop: vi.fn() } as unknown as Input['systemTTS'];
  function Harness({ changed = false }: { changed?: boolean }) {
    hook = usePlainTTS({
      client,
      owner,
      enabled: true,
      prepared: port,
      controller,
      systemTTS,
      contentRevision: 'r1',
      chapterId: 'c',
      rules: [],
      onError: vi.fn(),
      settings: {
        ...DEFAULT_TTS_PLAYBACK_SETTINGS,
        voiceSource: 'server',
        serverVoiceId: changed ? 'different' : 'old',
        plainChunking: changed ? 'sentence' : 'batch',
        rate: changed ? 1.8 : 1,
      },
    });
    return null;
  }
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<Harness />);
    });
    expect(hook.ready).toBe(false);
    await act(async () => {
      await hook.prefetch(playable, paragraph, 1);
      await hook.play(playable, paragraph, 1, progress);
    });
    await act(async () => {
      root.update(<Harness changed />);
    });
    await act(async () => {
      await hook.play(playable, paragraph, 2, progress);
    });
    expect(audio).toHaveBeenCalledTimes(1);
    expect(audio).toHaveBeenCalledWith('job', 3, expect.any(AbortSignal));
    expect(resolve).not.toHaveBeenCalled();
    expect(ordinary).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(0.7);
    expect(hook.retryTarget()).toEqual({ index: 0, fingerprint: ttsQueueItemFingerprint(playable) });
    await act(async () => {
      await hook.play(playable, paragraph, 3, undefined, { prepared: vi.fn() });
    });
    expect(resolve).toHaveBeenLastCalledWith('job', 3, true, expect.any(AbortSignal));
    expect(resolve).toHaveBeenCalledTimes(1);
    owner = {};
    await act(async () => {
      root.update(<Harness changed />);
    });
    expect(hook.retryTarget()).toBeUndefined();
  } finally {
    act(() => root?.unmount());
  }
});

it('releases a stalled prepared GET shared with prefetch and rereads without synthesizing or reusing another job audio', async () => {
  vi.useFakeTimers();
  let root: ReactTestRenderer | undefined;
  let staleRead!: AbortSignal;
  const audio = vi.fn().mockImplementationOnce((_: string, _index: number, signal: AbortSignal) => {
    staleRead = signal;
    return new Promise<Blob>(() => undefined);
  });
  const fresh = new Blob(['saved recovered']);
  const variant = new Blob(['new job voice']);
  audio.mockResolvedValueOnce(fresh).mockResolvedValueOnce(variant);
  const resolve = vi.fn();
  const synthesize = vi.fn();
  const onError = vi.fn();
  const playAudio = vi.fn(async () => true);
  const controller = {
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio,
    finishOperation: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as Input['controller'];
  const client = {
    listPlainTTSVoices: async () => ({ available: false, voices: [] }),
    synthesizePlainTTS: synthesize,
  } as unknown as Input['client'];
  const prepared = { audio, resolve } as unknown as Input['prepared'];
  const owner = {};
  const paragraph = { id: 'p', novelId: 'b', chapterId: 'c', index: 1, text: '이미 준비된 음성입니다.' } as Paragraph;
  const playable = {
    ...buildPlainTTSItems({ paragraph, rate: 1, chunking: 'sentence' })[0],
    preparedAudio: { id: 'saved', ordinal: 0, ready: true },
  };
  let hook!: ReturnType<typeof usePlainTTS>;
  function Harness() {
    hook = usePlainTTS({
      client,
      owner,
      prepared,
      enabled: true,
      chapterId: 'c',
      contentRevision: 'r1',
      settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server' },
      rules: [],
      controller,
      systemTTS: { stop: vi.fn() } as unknown as Input['systemTTS'],
      onError,
    });
    return null;
  }
  try {
    await act(async () => {
      root = create(<Harness />);
    });
    let prefetch!: Promise<void>;
    let playback!: Promise<boolean>;
    await act(async () => {
      prefetch = hook.prefetch(playable, paragraph, 1);
      playback = hook.play(playable, paragraph, 1);
      await Promise.resolve();
    });
    expect(audio).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
      await prefetch;
      expect(await playback).toBe(false);
    });
    expect(staleRead.aborted).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    await act(async () => {
      expect(await hook.play(playable, paragraph, 2)).toBe(true);
    });
    expect(playAudio).toHaveBeenLastCalledWith(fresh, 2, undefined);
    await act(async () => {
      await hook.play(playable, paragraph, 3);
    });
    expect(audio).toHaveBeenCalledTimes(2);
    await act(async () => {
      await hook.play({ ...playable, preparedAudio: { ...playable.preparedAudio, id: 'new-voice-job' } }, paragraph, 4);
    });
    expect(audio).toHaveBeenCalledTimes(3);
    expect(playAudio).toHaveBeenLastCalledWith(variant, 4, undefined);
    expect(resolve).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  } finally {
    if (root) act(() => root!.unmount());
    vi.useRealTimers();
  }
});

it('continues an old prepared snapshot only for a confirmed omission, not other missing audio', async () => {
  const resolve = vi.fn().mockRejectedValue(new RemoteApiError('omitted', 410, { code: 'tts_audio_skipped' }));
  const audio = vi.fn().mockRejectedValue(new RemoteApiError('pending', 404));
  const playAudio = vi.fn(async () => true),
    onError = vi.fn();
  const controller = {
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio,
    finishOperation: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as Input['controller'];
  const paragraph = { id: 'p', index: 1, chapterId: 'c', novelId: 'b', text: '누락된 부분입니다.' } as Paragraph;
  const playable = {
    ...buildPlainTTSItems({ paragraph, rate: 1 })[0],
    preparedAudio: { id: 'saved', ordinal: 0, ready: false },
  };
  let hook!: ReturnType<typeof usePlainTTS>, root!: ReactTestRenderer;
  const owner = {};
  function Harness() {
    hook = usePlainTTS({
      enabled: true,
      owner,
      settings: DEFAULT_TTS_PLAYBACK_SETTINGS,
      rules: [],
      controller,
      systemTTS: { stop: vi.fn() } as unknown as Input['systemTTS'],
      onError,
      prepared: { audio, resolve } as unknown as Input['prepared'],
    });
    return null;
  }
  await act(async () => {
    root = create(<Harness />);
  });
  try {
    await act(async () => {
      expect(await hook.play(playable, paragraph, 1)).toBe(true);
    });
    expect(playAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('건너뛴'));
    resolve.mockRejectedValue(new RemoteApiError('missing file', 410));
    await act(async () => {
      expect(await hook.play(playable, paragraph, 1)).toBe(false);
    });
    expect(playAudio).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
