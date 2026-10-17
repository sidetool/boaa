import type {
  ExternalSourceListInput,
  ExternalSourceFilterDefinition,
  ExternalSourceFilterValue,
} from '../../external-sources/contracts';
export function queryFingerprint(input: ExternalSourceListInput): string {
  return JSON.stringify({
    parentRef: input.parentRef ?? '',
    query: input.query?.trim() ?? '',
    browseMode: input.browseMode ?? '',
    filters: input.filters ?? [],
  });
}

export function defaultFilterValues(
  definitions: readonly ExternalSourceFilterDefinition[] | undefined,
): Readonly<Record<string, ExternalSourceFilterValue>> {
  return Object.fromEntries(
    (definitions ?? []).flatMap((definition) =>
      'defaultValue' in definition ? [[definition.id, definition.defaultValue] as const] : [],
    ),
  );
}
