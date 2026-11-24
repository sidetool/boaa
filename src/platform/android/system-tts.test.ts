import { describe, expect, it, vi } from 'vitest';
import { SystemTTSProvider } from '../../providers/tts';
import {
  ANDROID_SYSTEM_TTS_EVENT,
  AndroidSystemTTSProvider,
  createPlatformSystemTTSProvider,
  type AndroidSystemTtsBridge,
} from './system-tts';

class FakeSystemTtsBridge implements AndroidSystemTtsBridge {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, (payload: unknown) => void>();

  async invoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result> {
    this.calls.push({ command, args });
    if (command === 'getStatus') {
      return {
        supported: true,
        canSpeak: true,
        voicesAvailable: true,
        voiceCount: 1,
        message: 'ready',
        playback: {
          active: true,
          playing: false,
          paused: true,
          utteranceId: 'sentence-2',
          itemIndex: 1,
          positionMs: 420,
          itemCount: 3,
          updatedAtMs: 1_700_000_000_000,
          trackingJson: JSON.stringify({
            kind: 'reflowable_text',
            bookId: 'book-1',
            chapterId: 'chapter-1',
            blockId: 'paragraph-2',
            blockIndex: 4,
            startOffset: 10,
            endOffset: 20,
          }),
        },
      } as Result;
    }
    if (command === 'listVoices') {
      return { voices: [{ id: 'ko-voice', label: 'Korean', lang: 'ko-KR' }] } as Result;
    }
    return undefined as Result;
  }

  async listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
    this.listeners.set(event, handler);
    return () => this.listeners.delete(event);
  }

  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.(payload);
  }
}

describe('Android system TTS provider boundary', () => {
  it('maps native status and voices without leaking Kotlin objects into provider state', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);

    await expect(provider.getStatus()).resolves.toMatchObject({
      canSpeak: true,
      voiceCount: 1,
      playback: {
        active: true,
        paused: true,
        utteranceId: 'sentence-2',
        itemIndex: 1,
        positionMs: 420,
        anchor: { kind: 'reflowable_text', blockId: 'paragraph-2', startOffset: 10, endOffset: 20 },
      },
    });
    await expect(provider.listVoices()).resolves.toEqual([{ id: 'ko-voice', label: 'Korean', lang: 'ko-KR' }]);
  });

  it('routes playback callbacks and controls through one native provider bridge', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onPlaybackState = vi.fn();
    const unsubscribe = provider.subscribePlaybackState(onPlaybackState);

    await provider.speak({
      text: '안녕하세요.',
      rate: 1.1,
      voiceURI: 'ko-voice',
      mediaMetadata: { title: '2화', album: '돌아온 밤', artist: '서이레' },
      onStart,
      onEnd,
      onError,
    });
    const speakCall = bridge.calls.find((call) => call.command === 'speak');
    const utteranceId = String(speakCall?.args?.utteranceId);
    expect(speakCall?.args).toMatchObject({
      text: '안녕하세요.',
      rate: 1.1,
      voiceId: 'ko-voice',
      title: '2화',
      album: '돌아온 밤',
      artist: '서이레',
    });

    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, {
      utteranceId,
      phase: 'start',
      playback: {
        active: true,
        playing: true,
        paused: false,
        utteranceId,
        itemIndex: 0,
        positionMs: 0,
        itemCount: 1,
        updatedAtMs: 100,
        trackingJson: JSON.stringify({
          kind: 'fixed_text',
          bookId: 'book-1',
          chapterId: 'chapter-1',
          pageIndex: 2,
          textRevisionId: 'revision-2',
          blockId: 'block-4',
          startOffset: 0,
          endOffset: 10,
        }),
      },
    });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId, phase: 'end' });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onPlaybackState).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
        anchor: expect.objectContaining({ kind: 'fixed_text', pageIndex: 2, blockId: 'block-4' }),
      }),
    );
    unsubscribe();

    provider.pause();
    provider.resume();
    provider.stop();
    await vi.waitFor(() => {
      expect(bridge.calls.map((call) => call.command)).toEqual(
        expect.arrayContaining(['speak', 'pause', 'resume', 'stop']),
      );
    });
  });

  it('keeps device previews out of book session recovery while delivering their callbacks', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const onPlaybackState = vi.fn();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    provider.subscribePlaybackState(onPlaybackState);
    await provider.speak({ text: '선택 부분', rate: 1, previewSignal: new AbortController().signal, onStart, onEnd });
    const utteranceId = bridge.calls.find((call) => call.command === 'speak')?.args?.utteranceId;
    const playback = { active: true, playing: true, utteranceId, itemIndex: 0 };
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId, phase: 'start', playback });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onPlaybackState).toHaveBeenCalledExactlyOnceWith(undefined);
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId, phase: 'end' });
    expect(onEnd).toHaveBeenCalledOnce();
    vi.spyOn(bridge, 'invoke').mockResolvedValue({ playback });
    expect((await provider.getStatus()).playback).toBeUndefined();
  });
  it('does not start a cancelled preview while the native bridge becomes ready', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const request = new AbortController();
    const done = provider.speak({ text: '선택 부분', rate: 1, previewSignal: request.signal });
    request.abort();
    await done;
    expect(bridge.calls.some((call) => call.command === 'speak')).toBe(false);
  });
  it('cancels a preview on the fallback engine after native status polling succeeds again', async () => {
    const bridge = new FakeSystemTtsBridge();
    vi.spyOn(bridge, 'invoke').mockRejectedValueOnce(new Error('Speech engine initializing'));
    const provider = new AndroidSystemTTSProvider(bridge);
    const speak = vi.spyOn(SystemTTSProvider.prototype, 'speak').mockResolvedValue();
    const stop = vi.spyOn(SystemTTSProvider.prototype, 'stop').mockImplementation(() => {});
    try {
      await provider.speak({ text: '선택 부분', rate: 1, previewSignal: new AbortController().signal });
      expect(speak).toHaveBeenCalledOnce();
      await provider.getStatus();
      provider.stop();
      expect(stop).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.command === 'stop')).toBe(true));
    } finally {
      speak.mockRestore();
      stop.mockRestore();
    }
  });

  it('hands a sentence window to one native playlist and routes callbacks per item', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const firstStart = vi.fn();
    const firstEnd = vi.fn();
    const secondStart = vi.fn();
    const secondEnd = vi.fn();

    await provider.speakSequence([
      {
        text: '첫 문장.',
        rate: 1,
        pauseAfterMs: 180,
        playbackAnchor: {
          kind: 'reflowable_text',
          bookId: 'book-1',
          chapterId: 'chapter-1',
          blockId: 'paragraph-1',
          blockIndex: 0,
          startOffset: 0,
          endOffset: 5,
        },
        onStart: firstStart,
        onEnd: firstEnd,
      },
      { text: '둘째 문장.', rate: 1, pauseAfterMs: 0, onStart: secondStart, onEnd: secondEnd },
    ]);

    const batch = bridge.calls.find((call) => call.command === 'speakBatch');
    const items = batch?.args?.items as Array<{ utteranceId: string; pauseAfterMs: number; trackingJson?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0].pauseAfterMs).toBe(180);
    expect(JSON.parse(items[0].trackingJson!)).toMatchObject({
      kind: 'reflowable_text',
      blockId: 'paragraph-1',
      endOffset: 5,
    });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[0].utteranceId, phase: 'start' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[0].utteranceId, phase: 'end' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[1].utteranceId, phase: 'start' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[1].utteranceId, phase: 'end' });

    expect(firstStart).toHaveBeenCalledOnce();
    expect(firstEnd).toHaveBeenCalledOnce();
    expect(secondStart).toHaveBeenCalledOnce();
    expect(secondEnd).toHaveBeenCalledOnce();
  });

  it('selects the native provider only for the Tauri mobile runtime', () => {
    const mobile = createPlatformSystemTTSProvider({
      kind: 'tauri-mobile',
      hasTauri: true,
      isMobileWebView: true,
      userAgent: 'Android',
    });
    const desktop = createPlatformSystemTTSProvider({
      kind: 'tauri-desktop',
      hasTauri: true,
      isMobileWebView: false,
      userAgent: 'Windows',
    });

    expect(mobile).toBeInstanceOf(AndroidSystemTTSProvider);
    expect(desktop).not.toBeInstanceOf(AndroidSystemTTSProvider);
  });
});
