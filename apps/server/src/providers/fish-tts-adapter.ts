import type { TTSSynthesisInput, TTSSynthesisResult } from '../../../../src/providers/tts';
import { connectionSpeechModel, type TTSConnectionInput } from '../../../../src/providers/tts-connections';
import { fishDirection, fishLiteralText } from '../../../../src/providers/fish-performance';
import { requestLocalEndpoint, type LocalEndpointEgressOptions } from './local-endpoint-egress-policy.js';
import { ttsPolicyHttpError } from './tts-http-error.js';
import { connectionError } from './tts-connection-config.js';
import { wavFromPcm16 } from './tts-audio.js';

// Fish's documented PCM format is mono signed 16-bit; explicitly retain its 44.1 kHz default
// through gateways too. Wrapping PCM keeps prepared playback and split joins lossless.
const SAMPLE_RATE = 44100;
export class FishTTSAdapter {
  constructor(
    private readonly config: TTSConnectionInput,
    private readonly network: LocalEndpointEgressOptions,
  ) {}
  async listVoices() {
    return this.config.voices.map((v) => ({ ...v, lang: v.lang ?? 'und' }));
  }
  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const family = connectionSpeechModel(this.config);
    const raw = input.providerOptions?.instructions ?? input.providerOptions?.prompt;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > 2000))
      throw connectionError('말투 지시는 2,000자 이내로 입력해 주세요.');
    const direction = family && typeof raw === 'string' ? fishDirection(raw) : '';
    const text = family ? `${direction}${direction ? ' ' : ''}${fishLiteralText(input.text)}` : input.text;
    const voice = input.voiceProfile.providerVoiceId;
    if (!voice || !this.config.voices.some((v) => v.id === voice))
      throw connectionError('등록된 목소리를 선택해 주세요.');
    const native = this.config.protocol === 'fish';
    const router = this.config.protocol === 'openrouter';
    const format = router ? (family ? 'pcm' : 'mp3') : native ? 'pcm' : 'wav';
    const response = await requestLocalEndpoint(
      this.config.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          ...(native ? { model: this.config.modelId } : {}),
        },
        body: JSON.stringify(
          native
            ? {
                text,
                reference_id: voice,
                format,
                sample_rate: SAMPLE_RATE,
                prosody: { speed: input.speed ?? input.voiceProfile.speed ?? 1 },
              }
            : {
                model: this.config.modelId,
                input: text,
                voice,
                response_format: format,
                // Instructions are already rendered once in the input. OpenRouter would bracket them again.
                ...(router && family ? { provider: { options: { 'fish-audio': { sample_rate: SAMPLE_RATE } } } } : {}),
                speed: input.speed ?? input.voiceProfile.speed ?? 1,
              },
        ),
        signal: input.signal,
      },
      { ...this.network, allowedHosts: [new URL(this.config.url).hostname], maxResponseBytes: 32 * 1024 * 1024 },
    );
    if (!response.ok)
      throw await ttsPolicyHttpError(`음성 서비스 요청에 실패했어요. (HTTP ${response.status})`, response);
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('audio/') && type !== 'application/octet-stream') {
      await response.body?.cancel();
      throw connectionError('음성 서비스가 오디오 대신 다른 응답을 보냈어요.', 502);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 32 * 1024 * 1024)
      throw connectionError('음성 응답 크기가 올바르지 않아요.', 502);
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
      return {
        audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        contentType: 'audio/wav',
      };
    if (format === 'mp3' && ['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(type))
      return {
        audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        contentType: 'audio/mpeg',
      };
    if (format !== 'pcm' || !['audio/pcm', 'audio/raw', 'application/octet-stream'].includes(type) || bytes.length % 2)
      throw connectionError('음성 서비스의 오디오 형식이 요청한 형식과 달라요.', 502);
    const wav = wavFromPcm16(bytes, SAMPLE_RATE);
    return {
      audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      contentType: 'audio/wav',
    };
  }
}
