import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeakInput, TTSProvider } from '../../providers/tts';
import { DEFAULT_TTS_PLAYBACK_SETTINGS } from '../../providers/tts-playback-settings';
import { usePlainTTS } from './usePlainTTS';

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
