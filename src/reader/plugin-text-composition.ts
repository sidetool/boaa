import type { ReaderTextDecorationSegment } from './text-decorations';
import type { PluginParagraphLayer, PluginTextStyle } from './plugin-decoration-layers';
export interface ComposedReaderSegment extends ReaderTextDecorationSegment {
  pluginStyle?: PluginTextStyle;
}
/** Projection only: canonical offsets remain unchanged in storage and page fragments. */
export function composePluginText(
  text: string,
  segments: readonly ReaderTextDecorationSegment[],
  layers: readonly PluginParagraphLayer[],
  sourceOffset = 0,
  paragraphHighlight = false,
): ComposedReaderSegment[] {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) return segments as ComposedReaderSegment[];
  const ranges = layers
    .filter((layer) => layer.text.slice(sourceOffset, sourceOffset + text.length) === text)
    .flatMap((layer) =>
      layer.ranges.map((range) => ({
        ...range,
        start: Math.max(0, range.start - sourceOffset),
        end: Math.min(text.length, range.end - sourceOffset),
      })),
    )
    .filter((range) => range.end > range.start);
  if (!ranges.length) return segments as ComposedReaderSegment[];
  let offset = 0;
  const result: ComposedReaderSegment[] = [];
  for (const segment of segments) {
    const begin = offset,
      end = offset + segment.text.length;
    offset = end;
    const relevant = ranges.filter((range) => range.start < end && range.end > begin);
    const points = [
      ...new Set([
        begin,
        end,
        ...relevant.flatMap((range) => [Math.max(begin, range.start), Math.min(end, range.end)]),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i],
        stop = points[i + 1];
      const style: PluginTextStyle = {};
      for (const range of relevant) if (range.start <= start && range.end >= stop) Object.assign(style, range.style);
      // Native search/user highlight/TTS colors remain authoritative for readability.
      if (paragraphHighlight || segment.searchHit || segment.highlightColor || segment.ttsActive) {
        delete style.color;
        delete style.backgroundColor;
      }
      result.push({
        ...segment,
        text: text.slice(start, stop),
        ...(Object.keys(style).length ? { pluginStyle: style } : {}),
      });
    }
  }
  return result;
}
