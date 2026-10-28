import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioSession, type BrowserAudioElement } from '../providers/browser-audio-session';

class FakeAudio implements BrowserAudioElement {
  src = '';
  onended: HTMLAudioElement['onended'] = null;
  onerror: HTMLAudioElement['onerror'] = null;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removedAttributes: string[] = [];

  constructor(
    readonly url: string,
    private readonly shouldRejectPlay: () => boolean = () => false,
  ) {}

  async play(): Promise<void> {
    this.playCalls += 1;
    if (this.shouldRejectPlay()) throw new Error('play rejected');
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  removeAttribute(name: string): void {
    this.removedAttributes.push(name);
  }

  load(): void {
    this.loadCalls += 1;
  }
}

function blob(): Blob {
  return new Blob(['audio'], { type: 'audio/mpeg' });
}

function fireEnded(audio: FakeAudio): void {
  (audio.onended as ((event: Event) => void) | null)?.(new Event('ended'));
}

function createHarness(options: { rejectPlay?: () => boolean } = {}) {
  let nextUrl = 0;
  const created: FakeAudio[] = [];
  const revoked: string[] = [];
  const session = new BrowserAudioSession({
    createObjectUrl: () => `blob:test-${++nextUrl}`,
    revokeObjectUrl: (url) => {
      revoked.push(url);
    },
    createAudio: (url) => {
      const audio = new FakeAudio(url, options.rejectPlay);
      created.push(audio);
      return audio;
    },
  });
  return { session, created, revoked };
}

describe('BrowserAudioSession', () => {
  it('plays a blob through an object URL and revokes it on end', async () => {
    const { session, created, revoked } = createHarness();

    const result = session.playBlob(blob());
    expect(session.hasActivePlayback).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe('blob:test-1');

    fireEnded(created[0]);

    await expect(result).resolves.toBe(true);
    expect(session.hasActivePlayback).toBe(false);
    expect(revoked).toEqual(['blob:test-1']);
  });

  it('ignores a stale ended event while the current media has not ended', async () => {
    const { session, created } = createHarness();
    const first = session.playBlob(blob());
    fireEnded(created[0]);
    await first;
    const second = session.playBlob(blob());
    Object.defineProperty(created[0], 'ended', { value: false, configurable: true });
    fireEnded(created[0]);
    expect(session.hasActivePlayback).toBe(true);
    Object.defineProperty(created[0], 'ended', { value: true, configurable: true });
    fireEnded(created[0]);
    await expect(second).resolves.toBe(true);
  });
  it('returns false and cleans up when playback fails', async () => {
    const { session, revoked } = createHarness({ rejectPlay: () => true });

    await expect(session.playBlob(blob())).resolves.toBe(false);
    expect(session.hasActivePlayback).toBe(false);
    expect(revoked).toEqual(['blob:test-1']);
  });

  it('pauses and resumes the active audio element', async () => {
    const { session, created } = createHarness();

    const result = session.playBlob(blob());
    session.pause();
    await expect(session.resume()).resolves.toBe(true);
    fireEnded(created[0]);

    await expect(result).resolves.toBe(true);
    expect(created[0].pauseCalls).toBe(1);
    expect(created[0].playCalls).toBe(2);
  });

  it('stops active playback, clears the source, and resolves as handled', async () => {
    const { session, created, revoked } = createHarness();

    const result = session.playBlob(blob());
    session.stop(true);

    await expect(result).resolves.toBe(true);
    expect(session.hasActivePlayback).toBe(false);
    expect(created[0].pauseCalls).toBe(1);
    expect(created[0].removedAttributes).toEqual(['src']);
    expect(created[0].loadCalls).toBe(1);
    expect(revoked).toEqual(['blob:test-1']);
  });
});

it('reuses the authorized media element across chunks and ignores a late previous rejection', async () => {
  const { session, created, revoked } = createHarness();
  const first = session.playBlob(blob());
  const staleEnded = created[0].onended;
  fireEnded(created[0]);
  await first;
  const second = session.playBlob(blob());
  expect(created).toHaveLength(1);
  expect(created[0].src).toBe('blob:test-2');
  (staleEnded as (event: Event) => void)(new Event('ended'));
  expect(session.hasActivePlayback).toBe(true);
  fireEnded(created[0]);
  await expect(second).resolves.toBe(true);
  expect(revoked).toEqual(['blob:test-1', 'blob:test-2']);
});

it('reports real media progress and stops the old chunk from publishing after replacement', async () => {
  const { session, created } = createHarness();
  const progress: number[] = [];
  const first = session.playBlob(blob(), (value) => progress.push(value));
  const audio = created[0] as FakeAudio & {
    currentTime: number;
    duration: number;
    ontimeupdate: HTMLAudioElement['ontimeupdate'];
  };
  audio.currentTime = 5;
  audio.duration = 10;
  const old = audio.ontimeupdate as (event: Event) => void;
  old(new Event('timeupdate'));
  expect(progress).toEqual([0.5]);
  fireEnded(audio);
  await first;
  const second = session.playBlob(blob());
  old(new Event('timeupdate'));
  expect(progress).toEqual([0.5]);
  fireEnded(audio);
  await second;
  expect(audio.ontimeupdate).toBeNull();
});

it('changes speed on the same playing or paused audio without a new source or play call', async () => {
  const { session, created, revoked } = createHarness();
  const playing = session.playBlob(blob());
  const audio = created[0] as FakeAudio & {
    playbackRate: number;
    defaultPlaybackRate: number;
    preservesPitch: boolean;
  };
  session.setPlaybackRate(1.5);
  expect(audio.playbackRate).toBe(1.5);
  expect(audio.preservesPitch).toBe(true);
  expect(audio.src).toBe('blob:test-1');
  expect(audio.playCalls).toBe(1);
  expect(revoked).toHaveLength(0);
  session.pause();
  session.setPlaybackRate(0.8);
  expect(audio.playbackRate).toBe(0.8);
  expect(audio.defaultPlaybackRate).toBe(0.8);
  fireEnded(audio);
  await playing;
  const next = session.playBlob(blob());
  expect(created).toHaveLength(1);
  expect(audio.playbackRate).toBe(0.8);
  fireEnded(audio);
  await next;
});

class InterruptedAudio extends FakeAudio {
  currentTime = 0;
  duration = 10;
  ended = false;
  paused = false;
  onplaying: HTMLAudioElement['onplaying'] = null;
  onpause: HTMLAudioElement['onpause'] = null;
  onwaiting: HTMLAudioElement['onwaiting'] = null;
  ontimeupdate: HTMLAudioElement['ontimeupdate'] = null;
  pendingPlay = false;
  override play(): Promise<void> {
    this.playCalls++;
    if (this.pendingPlay) return new Promise(() => undefined);
    this.paused = false;
    return Promise.resolve();
  }
  override pause() {
    super.pause();
    this.paused = true;
    this.onpause?.call(this as unknown as HTMLAudioElement, new Event('pause'));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([true, false])(
  'bounds a media stall when the original play remains pending=%s and releases every resource',
  async (pending) => {
    vi.useFakeTimers();
    const audio = new InterruptedAudio('fixture');
    audio.pendingPlay = pending;
    const revoke = vi.fn();
    const playing = vi.fn();
    const session = new BrowserAudioSession({
      createAudio: () => audio,
      createObjectUrl: () => 'blob:stalled',
      revokeObjectUrl: revoke,
    });
    const result = session.playBlob(blob(), undefined, playing);
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(audio.playCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(result).resolves.toBe(false);
      expect(audio.playCalls).toBe(3);
      expect(audio.removedAttributes).toContain('src');
      expect(audio.loadCalls).toBe(1);
      expect(session.hasActivePlayback).toBe(false);
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:stalled');
      expect(playing).toHaveBeenLastCalledWith(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      session.stop(false);
    }
  },
);

it('recovers native pause and missed end on visibility changes while respecting explicit user pause', async () => {
  vi.useFakeTimers();
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const removeDocument = vi.spyOn(documentEvents, 'removeEventListener');
  const removeWindow = vi.spyOn(windowEvents, 'removeEventListener');
  vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('window', windowEvents);
  const audio = new InterruptedAudio('fixture');
  const playing = vi.fn();
  const session = new BrowserAudioSession({
    createAudio: () => audio,
    createObjectUrl: () => 'blob:interrupt',
    revokeObjectUrl: vi.fn(),
  });
  const result = session.playBlob(blob(), undefined, playing);
  try {
    await Promise.resolve();
    audio.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    // A platform pause does not set the session's explicit user-pause flag.
    audio.paused = true;
    audio.onpause?.call(audio as unknown as HTMLAudioElement, new Event('pause'));
    await Promise.resolve();
    expect(audio.playCalls).toBe(2);
    expect(playing).toHaveBeenLastCalledWith(true);
    session.pause();
    const before = audio.playCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    windowEvents.dispatchEvent(new Event('pageshow'));
    expect(audio.playCalls).toBe(before);
    expect(session.hasActivePlayback).toBe(true);
    expect(playing).toHaveBeenLastCalledWith(false);
    await session.resume();
    audio.ended = true;
    windowEvents.dispatchEvent(new Event('pageshow'));
    await expect(result).resolves.toBe(true);
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    session.stop(false);
  }
});

it('fences a late rejected resume against a replacement chunk on the same media element', async () => {
  const audio = new InterruptedAudio('fixture');
  let reject!: (reason: Error) => void;
  const session = new BrowserAudioSession({
    createAudio: () => audio,
    createObjectUrl: vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second'),
    revokeObjectUrl: vi.fn(),
  });
  const first = session.playBlob(blob());
  const play = vi.spyOn(audio, 'play').mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const resume = session.resume();
  const second = session.playBlob(blob());
  reject(Error('old resume rejected'));
  await expect(resume).resolves.toBe(true);
  expect(session.hasActivePlayback).toBe(true);
  expect(audio.src).toBe('blob:second');
  session.stop(true);
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  play.mockRestore();
});
