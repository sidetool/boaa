import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useTTSExecutionController, type TTSExecutionControllerInput } from './useTTSExecutionController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class TestAudioSession {
  active = false;
  stopCount = 0;
  readonly resumeResult = deferred<boolean>();

  get hasActivePlayback() {
    return this.active;
  }

  playBlob(): Promise<boolean> {
    this.active = true;
    return new Promise(() => undefined);
  }

  pause() {}

  resume(): Promise<boolean> {
    return this.resumeResult.promise;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stopCount += 1;
  }
}

describe('TTS execution controller', () => {
  it('adopts a surviving Android media session without stopping it on WebView teardown', async () => {
    const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    let controller!: ReturnType<typeof useTTSExecutionController>;
    const input: TTSExecutionControllerInput = {
      systemTTS,
      bookId: 'book-a',
      chapterId: 'chapter-a',
      preserveSystemPlaybackOnUnmount: true,
    };
    function Harness() {
      controller = useTTSExecutionController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(systemTTS.stop).not.toHaveBeenCalled();

    await act(async () => {
      controller.syncExternalPlayback({
        active: true,
        playing: true,
        paused: false,
        utteranceId: 'sentence-5',
        itemIndex: 4,
        positionMs: 800,
        itemCount: 12,
        updatedAtMs: 1000,
        anchor: {
          kind: 'reflowable_text',
          bookId: 'book-a',
          chapterId: 'chapter-a',
          blockId: 'paragraph-3',
          blockIndex: 3,
          startOffset: 4,
          endOffset: 12,
        },
      });
    });
    expect(controller.playing).toBe(true);
    expect(controller.paused).toBe(false);
    expect(controller.index).toBe(3);

    await act(async () => controller.pause());
    expect(systemTTS.pause).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
    expect(systemTTS.stop).not.toHaveBeenCalled();
  });

  it('does not let a stale resume failure stop the replacement session', async () => {
    const audioSession = new TestAudioSession();
    const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    let controller!: ReturnType<typeof useTTSExecutionController>;
    const input: TTSExecutionControllerInput = {
      systemTTS,
      audioSession,
      bookId: 'book-a',
      chapterId: 'chapter-a',
    };
    function Harness() {
      controller = useTTSExecutionController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    let firstSession!: number;
    await act(async () => {
      firstSession = controller.beginSession('book-a', 'chapter-a', 0)!;
      void controller.playAudio(new Blob(['first']), firstSession);
    });
    await act(async () => {
      controller.pause();
      controller.resume();
    });

    let replacementSession!: number;
    await act(async () => {
      replacementSession = controller.beginSession('book-a', 'chapter-a', 1)!;
      void controller.playAudio(new Blob(['replacement']), replacementSession);
    });
    expect(audioSession.stopCount).toBe(1);
    expect(audioSession.active).toBe(true);

    await act(async () => {
      audioSession.resumeResult.resolve(false);
      await audioSession.resumeResult.promise;
    });

    expect(audioSession.stopCount).toBe(1);
    expect(audioSession.active).toBe(true);
    await act(async () => renderer.unmount());
  });
});

it('revokes playback and warmup tokens when the session owner changes on the same book and chapter', async () => {
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  let controller!: ReturnType<typeof useTTSExecutionController>;
  function Harness({ owner }: { owner: object }) {
    controller = useTTSExecutionController({ systemTTS, bookId: 'book', chapterId: 'chapter', sessionOwner: owner });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness owner={{}} />);
  });
  let session: number | undefined;
  let warmup: ReturnType<typeof controller.beginWarmup>;
  act(() => {
    session = controller.beginSession('book', 'chapter');
    warmup = controller.beginWarmup('book', 'chapter');
  });
  expect(session).toBeDefined();
  expect(warmup).toBeDefined();
  const lease = warmup!;
  act(() => renderer.update(<Harness owner={{}} />));
  expect(lease.controller.signal.aborted).toBe(true);
  expect(controller.operationIsCurrent(lease)).toBe(false);
  expect(controller.isSessionCurrent(session!)).toBe(false);
  expect(controller.setHostedStatus(lease, 'stale')).toBe(false);
  expect(controller.warmupBusy).toBe(false);
  act(() => renderer.unmount());
});

it('carries completed opening audio across automatic chapter transitions but clears on stop and owner change', async () => {
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  let input: TTSExecutionControllerInput = { systemTTS, bookId: 'b', chapterId: 'c1', sessionOwner: {} };
  let controller!: ReturnType<typeof useTTSExecutionController>;
  function Harness() {
    controller = useTTSExecutionController(input);
    return null;
  }
  let renderer!: ReactTestRenderer;
  let session!: number;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    session = controller.beginSession('b', 'c1')!;
  });
  const audio = { cacheKey: 'opening', blob: new Blob(['audio']) };
  await act(async () => {
    controller.rememberPrefetched(session, 'opening', audio);
    controller.finishSession(session, { preserveSleepTimer: true });
  });
  input = { ...input, chapterId: 'c2' };
  await act(async () => {
    renderer.update(<Harness />);
  });
  await act(async () => {
    session = controller.beginSession('b', 'c2', 0, { preserveSleepTimer: true })!;
  });
  expect(controller.takePrefetched('opening')).toBe(audio);
  await act(async () => {
    controller.rememberPrefetched(session, 'opening', audio);
    controller.stopAll();
  });
  expect(controller.takePrefetched('opening')).toBeUndefined();
  await act(async () => {
    session = controller.beginSession('b', 'c2')!;
    controller.rememberPrefetched(session, 'opening', audio);
  });
  input = { ...input, chapterId: 'c3', sessionOwner: {} };
  await act(async () => {
    renderer.update(<Harness />);
  });
  expect(controller.takePrefetched('opening')).toBeUndefined();
  await act(async () => renderer.unmount());
});

it('restores the batch start after failure instead of resuming from estimated highlighting', async () => {
  let controller!: ReturnType<typeof useTTSExecutionController>;
  const input = { bookId: 'book', chapterId: 'chapter', systemTTS: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() } };
  function Harness() {
    controller = useTTSExecutionController(input);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  let session!: number;
  act(() => {
    session = controller.beginSession('book', 'chapter', 3)!;
    controller.setParagraph(session, 3);
  });
  act(() => {
    controller.setFollowedParagraph(session, 9);
  });
  expect(controller.index).toBe(9);
  act(() => {
    controller.finishSession(session, { preserveIndex: true, errorMessage: 'incomplete audio' });
  });
  expect(controller.index).toBe(3);
  act(() => renderer.unmount());
});

it('applies speed and sleep timer changes to a live item without restarting it', async () => {
  const audio = new TestAudioSession();
  const setPlaybackRate = vi.fn();
  Object.assign(audio, { setPlaybackRate });
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  let controller!: ReturnType<typeof useTTSExecutionController>;
  function Harness({ rate, timer }: { rate: number; timer?: 10 | 30 }) {
    controller = useTTSExecutionController({
      systemTTS,
      audioSession: audio,
      bookId: 'b',
      chapterId: 'c',
      playbackRate: rate,
      sleepTimerPreset: timer,
    });
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness rate={1} />);
  });
  let id!: number;
  act(() => {
    id = controller.beginSession('b', 'c', 0)!;
  });
  act(() => {
    void controller.playAudio(new Blob(['audio']), id);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(audio.active).toBe(true);
  const stopCount = audio.stopCount;
  const systemStops = systemTTS.stop.mock.calls.length;
  await act(async () => {
    root.update(<Harness rate={1.5} timer={10} />);
  });
  expect(controller.isSessionCurrent(id)).toBe(true);
  expect(controller.sleepTimerPreset).toBe(10);
  expect(controller.sleepTimerRemainingSeconds).toBeGreaterThan(599);
  expect(setPlaybackRate).toHaveBeenLastCalledWith(1.5);
  expect(audio.stopCount).toBe(stopCount);
  expect(systemTTS.stop).toHaveBeenCalledTimes(systemStops);
  act(() => controller.pause());
  await act(async () => {
    root.update(<Harness rate={0.8} timer={30} />);
  });
  expect(controller.paused).toBe(true);
  expect(controller.sleepTimerRemainingSeconds).toBe(1800);
  await act(async () => {
    root.update(<Harness rate={0.8} />);
  });
  expect(controller.sleepTimerPreset).toBeUndefined();
  expect(controller.isSessionCurrent(id)).toBe(true);
  act(() => root.unmount());
});

it('does not let an old play continuation replace the audio of a newly selected batch', async () => {
  const audio = new TestAudioSession();
  const play = vi.spyOn(audio, 'playBlob');
  let controller!: ReturnType<typeof useTTSExecutionController>;
  const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
  function Harness() {
    controller = useTTSExecutionController({ systemTTS, audioSession: audio, bookId: 'b', chapterId: 'c' });
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness />);
  });
  await act(async () => {
    const old = controller.beginSession('b', 'c', 0)!;
    const oldPlay = controller.playAudio(new Blob(['old']), old);
    controller.beginSession('b', 'c', 3);
    await oldPlay;
  });
  expect(play).not.toHaveBeenCalled();
  expect(controller.itemActive).toBe(false);
  act(() => root.unmount());
});
