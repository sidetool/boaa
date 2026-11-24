import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeakInput, TTSProvider } from '../../providers/tts';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import { usePlainTTS } from './usePlainTTS';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import { buildPlainTTSItems } from '../../providers/plain-tts';
import type { Paragraph } from '../../domain/types';

function deferred() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  return { promise, reject };
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});

function harness(speak: TTSProvider['speak'], overrides: Partial<Parameters<typeof usePlainTTS>[0]> = {}) {
  let hook!: ReturnType<typeof usePlainTTS>;
  const onError = vi.fn();
  const systemTTS: TTSProvider = {
    providerId: 'system',
    displayName: 'Device voice',
    getStatus: vi.fn(async () => ({
      supported: true,
      canSpeak: true,
      voicesAvailable: true,
      voiceCount: 1,
      message: '',
    })),
    listVoices: vi.fn(async () => []),
    speak,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  };
  const input: Parameters<typeof usePlainTTS>[0] = {
    enabled: false,
    settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, mode: 'plain', voiceSource: 'system' },
    rules: [],
    controller: { stopAll: vi.fn() } as unknown as Parameters<typeof usePlainTTS>[0]['controller'],
    systemTTS,
    onError,
    ...overrides,
  };
  function Harness() {
    hook = usePlainTTS(input);
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  return {
    get hook() {
      return hook;
    },
    onError,
    systemTTS,
  };
}

describe('plain device voice preview', () => {
  it('previews the exact selection with device speech even for a paid server voice and cancels on deselection', async () => {
    const synthesizePlainTTS = vi.fn();
    const speak = vi.fn(async (_input: SpeakInput) => {});
    const controller = { stopAll: vi.fn() };
    const view = harness(speak, {
      client: { synthesizePlainTTS } as unknown as RemoteApiClient,
      settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server', serverVoiceId: 'paid' },
      controller: controller as unknown as Parameters<typeof usePlainTTS>[0]['controller'],
    });
    const request = new AbortController();
    const text = ' 한 문장 중 일부\n다음 문장 일부 ';
    let done!: Promise<void>;
    act(() => {
      done = view.hook.preview({ text, signal: request.signal });
    });
    expect(speak.mock.calls[0][0].text).toBe(text);
    expect(view.hook.previewBusy).toBe(true);
    await act(async () => {
      request.abort();
      await done;
    });
    expect(speak.mock.calls[0][0].previewSignal?.aborted).toBe(true);
    expect(controller.stopAll).not.toHaveBeenCalled();
    expect(view.hook.previewBusy).toBe(false);
    expect(synthesizePlainTTS).not.toHaveBeenCalled();
  });

  it('reads a long selection serially without splitting surrogate pairs or dropping text', async () => {
    const speak = vi.fn(async (input: SpeakInput) => input.onEnd?.());
    const view = harness(speak);
    const text = '가'.repeat(999) + '😀' + ' 다른 문단\n'.repeat(800) + ' 끝';
    await act(async () => view.hook.preview({ text, signal: new AbortController().signal }));
    const chunks = speak.mock.calls.map(([input]) => input.text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000 && !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('does not queue the next part when a long device preview is cancelled', async () => {
    const speak = vi.fn(async (_input: SpeakInput) => {});
    const view = harness(speak);
    const request = new AbortController();
    let done!: Promise<void>;
    act(() => {
      done = view.hook.preview({ text: '긴 문장 '.repeat(1200), signal: request.signal });
    });
    expect(speak).toHaveBeenCalledOnce();
    await act(async () => {
      speak.mock.calls[0][0].onEnd?.();
      request.abort();
      await done;
    });
    expect(speak).toHaveBeenCalledOnce();
    expect(view.hook.previewBusy).toBe(false);
  });

  it('reports a rejected speak once and clears preview busy state', async () => {
    const speech = deferred();
    const speak = vi.fn(() => speech.promise);
    const view = harness(speak);
    let preview!: Promise<void>;
    act(() => {
      preview = view.hook.preview();
    });
    expect(view.hook.previewBusy).toBe(true);
    expect(speak).toHaveBeenCalledOnce();

    await act(async () => {
      speech.reject(new Error('Device voice failed'));
      await preview;
    });

    expect(view.onError).toHaveBeenCalledExactlyOnceWith('Device voice failed');
    expect(view.hook.previewBusy).toBe(false);
  });

  it('keeps a late speak rejection silent after preview cancellation', async () => {
    const speech = deferred();
    const view = harness(vi.fn(() => speech.promise));
    let preview!: Promise<void>;
    act(() => {
      preview = view.hook.preview();
    });
    expect(view.hook.previewBusy).toBe(true);

    await act(async () => {
      view.hook.stopPreview();
      await preview;
    });
    expect(view.hook.previewBusy).toBe(false);
    expect(view.systemTTS.stop).toHaveBeenCalledTimes(2);

    await act(async () => {
      speech.reject(new Error('Late device voice failure'));
      await Promise.resolve();
    });
    expect(view.onError).not.toHaveBeenCalled();
    expect(view.hook.previewBusy).toBe(false);
  });

  it('reports a device error callback once even when speak also rejects', async () => {
    const speech = deferred();
    let callbacks!: SpeakInput;
    const view = harness(
      vi.fn((input: SpeakInput) => {
        callbacks = input;
        return speech.promise;
      }),
    );
    let preview!: Promise<void>;
    act(() => {
      preview = view.hook.preview();
    });

    await act(async () => {
      callbacks.onError?.('Device callback failure');
      speech.reject(new Error('Duplicate device failure'));
      await preview;
    });

    expect(view.onError).toHaveBeenCalledExactlyOnceWith('Device callback failure');
    expect(view.hook.previewBusy).toBe(false);
  });
});

it('does not preview a paid fallback when the default server engine is unavailable', async () => {
  const synthesizePlainTTS = vi.fn();
  const client = {
    listPlainTTSVoices: vi.fn(async () => ({
      available: true,
      revision: 'v1',
      defaultVoiceId: '',
      voices: [{ id: 'gemini-tts:Kore', label: 'Kore', lang: 'und', paid: true }],
    })),
    synthesizePlainTTS,
  } as unknown as Parameters<typeof usePlainTTS>[0]['client'];
  const f = harness(vi.fn(), {
    client,
    settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, mode: 'plain', voiceSource: 'server', serverVoiceId: undefined },
  });
  await act(async () => {
    await f.hook.refresh();
  });
  expect(f.hook.ready).toBe(false);
  await act(async () => {
    await f.hook.preview();
  });
  expect(synthesizePlainTTS).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledWith('서버 목소리를 선택하세요.');
});

it('plays only cached server segments on a fresh mount when discovery is unavailable', async () => {
  const client = new RemoteApiClient('https://synthetic.invalid/api');
  const voice = {
    id: 'fixture:M1',
    label: 'Test voice',
    providerId: 'fixture',
    lang: 'ko',
    model: { providerId: 'fixture', revision: 'r1' },
  };
  const voices = {
    revision: 'catalog',
    available: true,
    defaultVoiceId: '',
    cachedDefaultVoiceId: voice.id,
    cachedVoices: [voice],
    voices: [{ id: 'other:M1', label: 'paid', providerId: 'other', lang: 'ko', paid: true }],
    providers: [
      { id: 'fixture', available: false },
      { id: 'other', available: true },
    ],
  };
  let available = true;
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith('/voices')) return Response.json(voices);
    if (!path.endsWith('/tts/plain/cached')) throw new Error('Unexpected synthesis request');
    expect(JSON.parse(String(init?.body))).toMatchObject({ voiceId: voice.id, voiceRevision: 'r1', cacheOnly: true });
    if (!available) return Response.json({ error: '저장된 음성이 없어요.' }, { status: 404 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const playAudio = vi.fn(async () => true);
  const controller = {
    stopAll: vi.fn(),
    beginHostedPlayback: () => ({ controller: new AbortController() }),
    isSessionCurrent: () => true,
    setHostedStatus: vi.fn(),
    playAudio,
    finishOperation: vi.fn(),
  } as unknown as Parameters<typeof usePlainTTS>[0]['controller'];
  const f = harness(vi.fn(), {
    client,
    controller,
    chapterId: 'chapter',
    contentRevision: 'content',
    settings: { ...DEFAULT_TTS_PLAYBACK_SETTINGS, voiceSource: 'server' },
  });
  try {
    await act(async () => f.hook.refresh());
    expect(f.hook.ready).toBe(true);
    expect(f.hook.cacheOnly).toBe(true);
    const read = async (id: string) => {
      const paragraph = { id, chapterId: 'chapter', novelId: 'book', index: 1, text: '테스트 문장.' } as Paragraph;
      const item = buildPlainTTSItems({ paragraph, rate: 1 })[0];
      return f.hook.play(item, paragraph, 1);
    };
    expect(await read('cached')).toBe(true);
    expect(playAudio).toHaveBeenCalledOnce();
    available = false;
    expect(await read('not-cached')).toBe(false);
    expect(playAudio).toHaveBeenCalledOnce();
    await act(async () => f.hook.preview());
    expect(calls).toEqual([
      '/api/tts/plain/voices',
      '/api/chapters/chapter/tts/plain/cached',
      '/api/chapters/chapter/tts/plain/cached',
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
