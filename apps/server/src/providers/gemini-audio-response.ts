/** Never turn a partial provider response into a successfully played batch. */
const incomplete = () =>
  Object.assign(
    new Error('음성 생성이 끝까지 완료되지 않았습니다. 읽던 묶음에서 다시 시도하거나 묶음 크기를 줄여 주세요.'),
    { code: 'tts_incomplete_audio' },
  );
interface AudioPart {
  buffer: Buffer;
  mimeType?: string;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function decode(value: unknown): Buffer | undefined {
  if (typeof value === 'string' && value.trim()) return Buffer.from(value, 'base64');
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
}
function collect(value: unknown): AudioPart[] {
  if (Array.isArray(value)) return value.flatMap(collect);
  const item = record(value);
  if (item.inlineData || item.inline_data) return collect(item.inlineData ?? item.inline_data);
  const mimeType = item.mimeType ?? item.mime_type;
  if ((typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('audio/')) || item.type === 'audio') {
    const buffer = decode(item.data);
    if (!buffer?.length) throw incomplete();
    return [{ buffer, mimeType: typeof mimeType === 'string' ? mimeType : undefined }];
  }
  return Object.values(item).flatMap(collect);
}
function wavParts(buffer: Buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    throw incomplete();
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw incomplete();
  let format: Buffer | undefined;
  const data: Buffer[] = [];
  for (let offset = 12; offset < buffer.length;) {
    if (offset + 8 > buffer.length) throw incomplete();
    const length = buffer.readUInt32LE(offset + 4),
      end = offset + 8 + length;
    if (end > buffer.length) throw incomplete();
    const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') format = buffer.subarray(offset + 8, end);
    if (type === 'data') data.push(buffer.subarray(offset + 8, end));
    offset = end + (length % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || !data.length) throw incomplete();
  const pcm = Buffer.concat(data);
  const alignment = format.readUInt16LE(12);
  if (!pcm.length || !alignment || pcm.length % alignment) throw incomplete();
  return { format, data: pcm };
}
function merge(parts: AudioPart[]): AudioPart {
  if (!parts.length) throw incomplete();
  const first = parts[0];
  const isWav = (part: AudioPart) => part.buffer.toString('ascii', 0, 4) === 'RIFF';
  if (parts.some(isWav)) {
    if (!parts.every(isWav)) throw incomplete();
    const wavs = parts.map((p) => wavParts(p.buffer));
    if (wavs.some((w) => !w.format.equals(wavs[0].format))) throw incomplete();
    if (parts.length === 1) return { buffer: first.buffer, mimeType: 'audio/wav' };
    const fmt = wavs[0].format,
      data = Buffer.concat(wavs.map((w) => w.data));
    const padding = fmt.length % 2,
      header = Buffer.alloc(12 + 8 + fmt.length + padding + 8);
    header.write('RIFF');
    header.writeUInt32LE(header.length + data.length + (data.length % 2) - 8, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(fmt.length, 16);
    fmt.copy(header, 20);
    header.write('data', 20 + fmt.length + padding);
    header.writeUInt32LE(data.length, 24 + fmt.length + padding);
    return { buffer: Buffer.concat([header, data, Buffer.alloc(data.length % 2)]), mimeType: 'audio/wav' };
  }
  const mime = (first.mimeType ?? 'audio/pcm').toLowerCase();
  if (parts.some((p) => (p.mimeType ?? 'audio/pcm').toLowerCase() !== mime)) throw incomplete();
  if (!/^audio\/(pcm|l16)(;|$)/.test(mime)) throw incomplete();
  return { buffer: Buffer.concat(parts.map((p) => p.buffer)), mimeType: first.mimeType };
}
export function vertexAudioResponse(value: unknown): AudioPart {
  const body = record(value);
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || !candidates.length) throw incomplete();
  const candidate = record(candidates[0]);
  if ((candidate.finishReason ?? candidate.finish_reason) !== 'STOP') throw incomplete();
  // Alternatives are not successive audio; never merge separate candidates or request echoes.
  return merge(collect(record(candidate.content).parts));
}
export function interactionAudioResponse(value: unknown): AudioPart {
  const body = record(value);
  if (body.status !== undefined && body.status !== 'completed') throw incomplete();
  const direct = record(body.output_audio ?? body.outputAudio);
  if (direct.data) return merge(collect({ ...direct, type: 'audio' }));
  return merge(collect(body.outputs ?? body.steps ?? body.output));
}
