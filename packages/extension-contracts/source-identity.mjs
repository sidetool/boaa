// These namespaces are persisted in library links, home rows and hashed reference directories.
// They are wire/storage identities, independent of the current product name.
export const COMPATIBILITY_SOURCE_NAMESPACES = Object.freeze({
  apk: 'moya.apk',
  mangayomi: 'moya.mangayomi',
});

export function canonicalCompatibilitySourceId(value) {
  return value.replace(/^boaa\.(apk|mangayomi)(?=\.[a-f0-9]{24}\.-?\d+$)/, 'moya.$1');
}

export function compatibilitySourceIdsEqual(left, right) {
  return canonicalCompatibilitySourceId(left) === canonicalCompatibilitySourceId(right);
}

export function compatibilitySourceIdAliases(value) {
  const canonical = canonicalCompatibilitySourceId(value);
  return /^moya\.(apk|mangayomi)\.[a-f0-9]{24}\.-?\d+$/.test(canonical)
    ? [canonical, canonical.replace(/^moya\./, 'boaa.')]
    : [value];
}
