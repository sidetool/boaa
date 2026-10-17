export const COMPATIBILITY_SOURCE_NAMESPACES: Readonly<{ apk: 'moya.apk'; mangayomi: 'moya.mangayomi' }>;
export function canonicalCompatibilitySourceId(value: string): string;
export function compatibilitySourceIdsEqual(left: string, right: string): boolean;
export function compatibilitySourceIdAliases(value: string): string[];
