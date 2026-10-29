import { GoogleAuth } from 'google-auth-library';
import { isGeminiVoiceDesignModel } from '../../../../src/providers/voice-library';
import type { GeminiVertexTTSProviderOptions } from './gemini-vertex-tts-provider';
import { googleTtsHttpError } from './tts-http-error';
import { wavFromPcm16 } from './tts-audio';

export function supportsVertexVoiceDesign(v: GeminiVertexTTSProviderOptions) {
  return (
    isGeminiVoiceDesignModel(v.modelId) &&
    v.location === 'global' &&
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(v.project ?? '')
  );
}
export async function vertexVoiceDesign(
  v: GeminiVertexTTSProviderOptions,
  input: { alias: string; prompt: string; language: string; modelId: string; signal: AbortSignal },
) {
  if (!supportsVertexVoiceDesign(v) || !isGeminiVoiceDesignModel(input.modelId))
    throw new Error('Voice design requires Gemini 3.8 TTS in global');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120000)]);
  signal.throwIfAborted();
  const access =
    v.designAccessToken ??
    (async () => {
      const auth = new GoogleAuth({
        credentials: v.serviceAccount ? { ...v.serviceAccount } : undefined,
        keyFilename: v.credentialsPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      try {
        const token = await auth.getAccessToken();
        if (!token) throw Error();
        return token;
      } catch {
        throw new Error('Vertex voice design authentication failed');
      }
    });
  let cancel: (() => void) | undefined;
  const token = await Promise.race([
    access(signal),
    new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    }),
  ]).finally(() => {
    if (cancel) signal.removeEventListener('abort', cancel);
  });
  signal.throwIfAborted();
  if (!token || /\s/.test(token)) throw new Error('Invalid Vertex access token');
  const response = await (v.designFetch ?? fetch)(
    `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(v.project!)}/locations/global/voices`,
    {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: true,
        voice: {
          type: 'VOICE_TYPE_PROMPTED',
          displayName: input.alias,
          ...(input.language ? { languageCode: input.language } : {}),
          prompted: { input: input.prompt },
        },
      }),
    },
  );
  if (!response.ok) {
    throw await googleTtsHttpError(`Vertex voice design failed with ${response.status}`, response);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Vertex voice design returned no response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const aborted = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const r = await reader.read();
      signal.throwIfAborted();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > 6 * 1024 * 1024) {
        await reader.cancel();
        throw Error('Vertex voice design response too large');
      }
      chunks.push(r.value);
    }
  } finally {
    signal.removeEventListener('abort', aborted);
    reader.releaseLock();
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('Invalid Vertex voice response');
  }
  if (!value || typeof value.id !== 'string' || !/^voice_[A-Za-z0-9_-]{1,240}$/.test(value.id))
    throw Error('Invalid Vertex voice ID');
  const audio = value.sample_audio ?? value.sampleAudio;
  let sample;
  if (audio) {
    const mime = audio.mime_type ?? audio.mimeType;
    if (typeof audio.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data) || typeof mime !== 'string')
      throw Error('Invalid Vertex voice sample');
    let data: Buffer = Buffer.from(audio.data, 'base64');
    let contentType = mime.toLowerCase();
    if (!data.length || data.length > 4 * 1024 * 1024) throw Error('Invalid Vertex voice sample size');
    if (/^audio\/l16;\s*rate=24000;\s*channels=1$/.test(contentType)) {
      if (data.length % 2) throw Error('Invalid PCM sample');
      data = wavFromPcm16(data, 24000);
      contentType = 'audio/wav';
    }
    if (
      !['audio/wav', 'audio/mpeg'].includes(contentType) ||
      data.length > 4 * 1024 * 1024 ||
      (contentType === 'audio/wav' &&
        (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'))
    )
      throw Error('Invalid Vertex voice sample encoding');
    sample = { data, contentType };
  }
  return { id: value.id as string, sample };
}
