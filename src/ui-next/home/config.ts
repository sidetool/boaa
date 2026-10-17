import type { HomeDiscoverySection } from './discovery';
import { normalizeHomeRows } from '@boaa/reader-core/settings';
import type { HomeRowConfig, HomeRowOption } from './contract';

const choices: HomeRowOption[] = [
  { kind: 'recently-added', label: '최근 추가한 작품', hint: '최근에 서재에 추가한 작품' },
  { kind: 'unread', label: '아직 안 읽은 작품', hint: '새로 시작할 작품' },
  { kind: 'finished', label: '완독한 작품', hint: '끝까지 읽은 작품' },
  { kind: 'favorites', label: '즐겨찾기', hint: '즐겨찾기에 담은 작품' },
  { kind: 'external-updates', label: '새 회차', hint: '새 회차가 있는 외부 작품' },
];
export function defaultHomeRows(): HomeRowConfig[] {
  return ['recently-added', 'unread', 'external-updates', 'favorites'].map((kind) => ({
    id: kind,
    kind: kind as HomeRowConfig['kind'],
    visible: true,
  }));
}
/** Missing shelves are filtered from the view, never destructively saved during bootstrap. */
export function resolveHomeRows(
  config: readonly HomeRowConfig[] | undefined,
  shelves: readonly { id: string }[],
  discovery: readonly HomeDiscoverySection[] = [],
  sources: readonly { id: string }[] = [],
): HomeRowConfig[] {
  return (normalizeHomeRows(config) ?? defaultHomeRows()).filter(
    (row) =>
      (row.kind !== 'shelf' || shelves.some((shelf) => shelf.id === row.shelfId)) &&
      (row.kind !== 'discovery' || discovery.some((list) => list.id === row.discoveryTabId)) &&
      (row.kind !== 'source' || sources.some((source) => source.id === row.section?.sourceId)),
  );
}
export function homeRowOptions(
  config: readonly HomeRowConfig[],
  shelves: readonly { id: string; name: string }[],
  discovery: readonly HomeDiscoverySection[] = [],
): HomeRowOption[] {
  const options: HomeRowOption[] = [
    ...choices,
    ...discovery.map((list) => ({
      kind: 'discovery' as const,
      discoveryTabId: list.id,
      label: list.sourceLabel,
      hint: `탐색 목록 · ${list.tabTitle} · ${list.title}`,
    })),
    ...shelves.map((shelf) => ({
      kind: 'shelf' as const,
      shelfId: shelf.id,
      label: shelf.name,
      hint: '책장에 담은 작품',
    })),
  ];
  return options.filter(
    (option) =>
      !config.some(
        (row) =>
          row.kind === option.kind && row.shelfId === option.shelfId && row.discoveryTabId === option.discoveryTabId,
      ),
  );
}
export function homeRowLabel(
  row: HomeRowConfig,
  shelves: readonly { id: string; name: string }[],
  discovery: readonly HomeDiscoverySection[] = [],
): string {
  if (row.kind === 'source') return row.section?.title ?? '';
  // Same title the home screen shows above the row ("네이버 웹툰 · 인기"), not just the source name.
  if (row.kind === 'discovery') return discovery.find((list) => list.id === row.discoveryTabId)?.title ?? '탐색';
  return row.kind === 'shelf'
    ? (shelves.find((shelf) => shelf.id === row.shelfId)?.name ?? '책장')
    : (choices.find((option) => option.kind === row.kind)?.label ?? '탐색');
}

/** Preserve rows omitted from the editor while their shelf/tab is unavailable. */
export function mergeHomeRowEdits(
  saved: readonly HomeRowConfig[] | undefined,
  editable: readonly HomeRowConfig[],
  edited: readonly HomeRowConfig[],
): HomeRowConfig[] {
  const next = normalizeHomeRows(edited) ?? [];
  const editableIds = new Set(editable.map((row) => row.id));
  for (const [index, row] of (normalizeHomeRows(saved) ?? defaultHomeRows()).entries()) {
    if (!editableIds.has(row.id) && !next.some((candidate) => candidate.id === row.id))
      next.splice(Math.min(index, next.length), 0, row);
  }
  return next;
}
