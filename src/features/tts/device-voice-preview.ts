import type { SpeakInput, TTSProvider } from '../../providers/tts';

// Leave room under native speech engines' per-utterance limit, measured in UTF-16 units.
const MAX_PREVIEW_UNITS = 1_000;

function* previewChunks(text: string) {
  let start = 0;
  while (text.length - start > MAX_PREVIEW_UNITS) {
    const candidate = text.slice(start, start + MAX_PREVIEW_UNITS);
    const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    let length = boundary >= 0 ? boundary + 1 : candidate.length;
    if (/[\uD800-\uDBFF]/u.test(candidate[length - 1])) length--;
    yield text.slice(start, start + length);
    start += length;
  }
  if (start < text.length) yield text.slice(start);
}

export async function playDeviceVoicePreview(
  provider: TTSProvider,
  input: Pick<SpeakInput, 'text' | 'voiceURI' | 'rate' | 'pitch' | 'volume'>,
  signal: AbortSignal,
): Promise<void> {
  for (const text of previewChunks(input.text)) {
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        provider.stop();
        finish();
      };
      const fail = (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      };
      signal.addEventListener('abort', cancel, { once: true });
      void provider
        .speak({
          ...input,
          text,
          previewSignal: signal,
          onEnd: finish,
          onError: (message) => fail(new Error(message)),
        })
        .catch(fail);
    });
  }
}
