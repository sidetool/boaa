import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';
import type { TTSConnectionInput } from '../../../../src/providers/tts-connections';
import type { LocalEndpointEgressOptions } from './local-endpoint-egress-policy.js';
import { LocalEndpointTTSProvider } from './local-endpoint-tts-provider.js';
import { connectionError } from './tts-connection-config.js';

/** Keep the reader's source anchors intact while respecting the engine's per-request text budget. */
export class ConnectionTTSProvider implements TTSSynthesisProvider {
  readonly supportsStreaming = false;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;
  readonly displayName: string;
  private readonly adapter: LocalEndpointTTSProvider;
  constructor(
    readonly providerId: string,
    private readonly config: TTSConnectionInput,
    private readonly checkCurrent: () => Promise<void>,
    network: LocalEndpointEgressOptions = {},
  ) {
    this.displayName = config.name;
    this.adapter = new LocalEndpointTTSProvider({
      ...network,
      endpointUrl: config.url,
      modelId: config.modelId,
      apiKey: config.apiKey,
      allowedHosts: [new URL(config.url).hostname],
      voices: config.voices.map((v) => ({ ...v, lang: v.lang ?? 'und' })),
    });
  }
  listVoices() {
    return this.adapter.listVoices();
  }
  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const parts = splitConnectionText(input.text, this.config.maxInputCharacters);
    if (parts.length > this.config.maxInputSegments)
      throw connectionError('요청이 너무 길어요. 낭독 묶음 크기를 줄이거나 연결의 최대 구간 수를 늘려 주세요.');
    const results: TTSSynthesisResult[] = [];
    let bytes = 0;
    for (const text of parts) {
      input.signal?.throwIfAborted();
      await this.checkCurrent();
      const result = await this.adapter.synthesize({ ...input, text, format: 'wav' });
      await this.checkCurrent();
      bytes += result.audio.byteLength;
      if (!result.audio.byteLength || bytes > 32 * 1024 * 1024)
        throw connectionError('음성 응답 크기가 올바르지 않아요.', 502);
      // Reject a non-PCM response before paying for further pieces of an unmergeable recording.
      if (parts.length > 1) joinConnectionWav([Buffer.from(result.audio)]);
      results.push(result);
    }
    if (results.length === 1) return results[0];
    return { audio: joinConnectionWav(results.map((r) => Buffer.from(r.audio))), contentType: 'audio/wav' };
  }
}

export function splitConnectionText(text: string, limit: number): string[] {
  const points = Array.from(text),
    result: string[] = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(points.length, start + limit);
    if (end < points.length) {
      for (let at = end; at > start + limit / 2; at--) {
        if (/[\s.!?。！？]/u.test(points[at - 1])) {
          end = at;
          break;
        }
      }
    }
    result.push(points.slice(start, end).join(''));
    start = end;
  }
  return result;
}

export function joinConnectionWav(buffers: Buffer[]): ArrayBuffer {
  const invalid = () =>
    connectionError('나뉜 음성을 합칠 수 없어요. 서버의 PCM WAV 지원을 확인하거나 낭독 묶음 크기를 줄여 주세요.', 502);
  const parts = buffers.map((buffer) => {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
      throw invalid();
    let format: Buffer | undefined;
    const data: Buffer[] = [];
    for (let at = 12; at < buffer.length;) {
      if (at + 8 > buffer.length) throw invalid();
      const size = buffer.readUInt32LE(at + 4),
        end = at + 8 + size;
      if (end + (size % 2) > buffer.length) throw invalid();
      const type = buffer.toString('ascii', at, at + 4);
      if (type === 'fmt ') format = buffer.subarray(at + 8, end);
      if (type === 'data') data.push(buffer.subarray(at + 8, end));
      at = end + (size % 2);
    }
    if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || !data.length) throw invalid();
    const pcm = Buffer.concat(data),
      alignment = format.readUInt16LE(12);
    if (!alignment || !pcm.length || pcm.length % alignment) throw invalid();
    return { format, pcm };
  });
  if (!parts.length || parts.some((p) => !p.format.equals(parts[0].format))) throw invalid();
  const format = parts[0].format,
    pcm = Buffer.concat(parts.map((p) => p.pcm));
  const header = Buffer.alloc(28 + format.length + (format.length % 2));
  header.write('RIFF');
  header.writeUInt32LE(header.length + pcm.length + (pcm.length % 2) - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(format.length, 16);
  format.copy(header, 20);
  header.write('data', header.length - 8);
  header.writeUInt32LE(pcm.length, header.length - 4);
  const joined = Buffer.concat([header, pcm, Buffer.alloc(pcm.length % 2)]);
  return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer;
}
