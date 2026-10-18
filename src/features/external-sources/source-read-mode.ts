import type { ExternalItemSummary } from '../../external-sources/contracts';
import {
  sourceReadingPreferences,
  type SourceReadingPreferences,
} from '../../external-sources/source-reading-preferences';
import { isTextStream, type SourceReadingPort } from '../../external-sources/source-text-stream';

/** Text sources use their text preference; image sources use the comic reading mode. */
export function sourceReadMode(
  item: ExternalItemSummary,
  port?: SourceReadingPort,
  preferences: SourceReadingPreferences = sourceReadingPreferences(),
): SourceReadingPreferences['mode'] {
  const text = isTextSourceItem(item, port);
  return text ? (preferences.textMode === 'library' ? 'download' : 'stream') : preferences.mode;
}
export function isTextSourceItem(item: ExternalItemSummary, port?: SourceReadingPort): boolean {
  return Boolean(
    port ? isTextStream(port) : item.formatHint?.toLowerCase() === 'txt' || item.mimeType?.startsWith('text/'),
  );
}
export function preferTextLibrary(item: ExternalItemSummary, port?: SourceReadingPort, scope?: string): boolean {
  return isTextSourceItem(item, port) && sourceReadingPreferences(scope).textMode === 'library';
}
