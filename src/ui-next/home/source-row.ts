import { normalizeHomeSourceSection } from '@boaa/reader-core/settings';
import type { ExternalSourceFilterDefinition, ExternalSourceListInput } from '../../external-sources/contracts';
import type { HomeSourceRowSection } from './contract';

/** Identical to discovery's filter apply request; the saved mode remains the unfiltered fallback. */
export function sourceRowInput(
  section: Pick<HomeSourceRowSection, 'mode'> & Pick<ExternalSourceListInput, 'filters' | 'parentRef'>,
): ExternalSourceListInput {
  return {
    parentRef: section.parentRef,
    browseMode: section.filters?.length ? 'search' : section.mode,
    filters: section.filters,
  };
}

/** Optional definitions capture the schema at save time; callers never need to construct a signature. */
export function normalizeSourceRowSection(
  section: unknown,
  definitions?: readonly ExternalSourceFilterDefinition[],
): HomeSourceRowSection | undefined {
  const normalized = normalizeHomeSourceSection(section);
  if (!normalized) return;
  return normalizeHomeSourceSection({
    ...normalized,
    ...(definitions && normalized.filters?.length ? { filterSignature: JSON.stringify(definitions) } : {}),
  });
}

export function sourceRowSummary(
  section: Pick<HomeSourceRowSection, 'mode'> & Pick<ExternalSourceListInput, 'filters'>,
  definitions: readonly ExternalSourceFilterDefinition[],
): string {
  const labels = [section.mode === 'popular' ? '인기' : '최신'];
  for (const definition of definitions) {
    if (definition.kind === 'header' || definition.kind === 'separator') continue;
    const value = section.filters?.find(
      (filter) => filter.position === definition.position && filter.groupPosition === definition.groupPosition,
    )?.value;
    if (value === undefined || JSON.stringify(value) === JSON.stringify(definition.defaultValue)) continue;
    let label: string | undefined;
    switch (definition.kind) {
      case 'select':
        if (typeof value === 'number') label = definition.options[value];
        break;
      case 'text':
        if (typeof value === 'string') label = value.trim();
        break;
      case 'checkbox':
        if (value === true) label = definition.label;
        break;
      case 'tri_state':
        if (value === 'INCLUDE') label = definition.label;
        if (value === 'EXCLUDE') label = `${definition.label} 제외`;
        break;
      case 'sort':
        if (typeof value === 'object' && definition.options[value.index])
          label = `${definition.options[value.index]} ${value.ascending ? '↑' : '↓'}`;
        break;
    }
    if (label) labels.push(label);
  }
  return labels.join(' · ');
}
