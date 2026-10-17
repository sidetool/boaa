import { normalizeDiscoveryConfig } from './discovery-settings.js';
import type { ReaderHomeSourceSection, ReaderSettings } from '@boaa/contracts';

type HomeRows = NonNullable<ReaderSettings['homeRows']>;
const kinds = new Set([
  'recently-added',
  'unread',
  'finished',
  'favorites',
  'shelf',
  'external-updates',
  'discovery',
  'source',
]);
export const MAX_HOME_ROWS = 100;
export const MAX_HOME_ROWS_BYTES = 512 * 1024;

/** Apply the discovery wire limits and strip transient fields from an independently saved row. */
export function normalizeHomeSourceSection(value: unknown): ReaderHomeSourceSection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sourceId !== 'string' || !raw.sourceId.trim()) return;
  if (raw.summary !== undefined && (typeof raw.summary !== 'string' || raw.summary.length > 1024)) return;
  const normalized = normalizeDiscoveryConfig({
    version: 1,
    tabs: [
      {
        id: 'home',
        title: '',
        hidden: false,
        density: 'comfortable',
        sections: [{ ...raw, id: 'home' }],
      },
    ],
  })?.tabs[0]?.sections[0];
  if (!normalized) return;
  const { id: _id, filters, ...section } = normalized;
  return {
    ...section,
    ...(filters === undefined ? {} : { filters: [...filters] }),
    ...(raw.summary === undefined ? {} : { summary: raw.summary as string }),
  };
}

/** Missing layout means defaults; an explicit empty array means no rows. */
export function normalizeHomeRows(value: unknown): HomeRows | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const rows: HomeRows = [];
  for (const candidate of value.slice(0, MAX_HOME_ROWS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { id, kind, visible, shelfId, discoveryTabId } = candidate;
    if (
      typeof id !== 'string' ||
      id.length > 1024 ||
      !id.trim() ||
      ids.has(id) ||
      !kinds.has(kind) ||
      typeof visible !== 'boolean'
    )
      continue;
    if (kind === 'shelf' && (typeof shelfId !== 'string' || !shelfId.trim())) continue;
    if (kind === 'discovery' && (typeof discoveryTabId !== 'string' || !discoveryTabId.trim())) continue;
    const section = kind === 'source' ? normalizeHomeSourceSection(candidate.section) : undefined;
    if (kind === 'source' && !section) continue;
    ids.add(id);
    rows.push({
      id,
      kind,
      visible,
      ...(kind === 'shelf' ? { shelfId } : {}),
      ...(kind === 'discovery' ? { discoveryTabId } : {}),
      ...(section ? { section } : {}),
    });
  }
  return new TextEncoder().encode(JSON.stringify(rows)).length <= MAX_HOME_ROWS_BYTES ? rows : undefined;
}
export function normalizeStartupScreen(value: unknown): ReaderSettings['startupScreen'] {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'home') return { kind: 'home' };
  if (candidate.kind === 'library')
    return { kind: 'library', ...(typeof candidate.shelfId === 'string' ? { shelfId: candidate.shelfId } : {}) };
  if (candidate.kind === 'discovery')
    return { kind: 'discovery', ...(typeof candidate.tabId === 'string' ? { tabId: candidate.tabId } : {}) };
}
