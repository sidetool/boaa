import type { AudiobookPort } from '../../providers/plain-audiobook';

/** Always check durable audio before synthesis, even if the chapter's readiness snapshot is old. */
export async function loadPreparedAudio(
  port: AudiobookPort,
  item: { id: string; ordinal: number; ready: boolean },
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  try {
    return await port.audio(item.id, item.ordinal, signal);
  } catch (error) {
    signal.throwIfAborted();
    // Only a genuinely pending item may generate. Transport, permission and missing-file errors never do.
    if (item.ready || (error as { status?: number })?.status !== 404) throw error;
    return port.resolve(item.id, item.ordinal, false, signal);
  }
}
