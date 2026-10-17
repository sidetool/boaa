/** Read adapters for data written before the BOAA namespace. Never rewrite user text or source identities. */
export function legacyBrandNames(name: string): string[] {
  // Only the host namespace changes. Origins, client IDs and other scoped suffixes are opaque.
  const namespace = /^((?:\/|_{1,2}|[Xx]-|application\/vnd\.)?)(boaa|Boaa|BOAA)(?=$|[-._:/\s]|[A-Z])/.exec(name);
  if (!namespace) return [];
  const variants = [
    ['moya', 'Moya', 'MOYA'],
    ['noveldesk', 'NovelDesk', 'NOVELDESK'],
    ['moa', 'Moa', 'MOA'],
  ];
  const suffix = name.slice(namespace[0].length);
  return variants.map(
    ([lower, title, upper]) =>
      namespace[1] + (namespace[2] === 'boaa' ? lower : namespace[2] === 'Boaa' ? title : upper) + suffix,
  );
}

export function readBrandHeader(headers: { get(name: string): string | null }, name: string): string | null {
  const current = headers.get(name);
  if (current !== null) return current;
  for (const alias of legacyBrandNames(name)) {
    const value = headers.get(alias);
    if (value !== null) return value;
  }
  return null;
}

export function isBrandValue(value: unknown, canonical: string): boolean {
  return value === canonical || legacyBrandNames(canonical).includes(value as string);
}

/** Reserved host-owned names only. Arbitrary third-party IDs and strings remain unchanged. */
export function isStableLegacyIdentity(value: string): boolean {
  return (
    value.startsWith('moya.external.') ||
    value.startsWith('moya.local.') ||
    /^moya\.(?:apk|mangayomi)\.[a-f0-9]{24}\.-?\d+(?=$|[:/])/.test(value) ||
    value.startsWith('moya.ai.tts.book-preparation') ||
    value === '__moya_global_comic_profile__' ||
    value === 'moya.ai.tts.detailed.speaker-preparation' ||
    value === 'moya.ai.analysis.character-bundle'
  );
}

function canonicalKey(key: string): string {
  if (isStableLegacyIdentity(key)) return key;
  return key
    .replace(/^_(?:moya|noveldesk)(?=[A-Z_.:])/, '_boaa')
    .replace(/^__(?:moya|noveldesk)_/, '__boaa_')
    .replace(/^(?:moya|noveldesk)\./, 'boaa.')
    .replace(/^(?:moya|noveldesk)(Api|Series)$/, 'boaa$1');
}

export function normalizeBrandRecord<T>(value: T, seen = new WeakSet<object>(), depth = 0): T {
  if (value && typeof value === 'object') {
    if (depth > 64 || seen.has(value)) return value;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((entry) => !('value' in entry))) return value;
  }
  if (Array.isArray(value)) {
    const result = value.map((entry: unknown) => normalizeBrandRecord(entry, seen, depth + 1));
    return (result.some((entry, index) => entry !== value[index]) ? result : value) as T;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  let changed = false;
  for (const [key, raw] of Object.entries(input)) {
    const nextKey = canonicalKey(key);
    // An explicitly written BOAA value wins over the legacy property, including null/false/empty values.
    if (nextKey !== key && Object.prototype.hasOwnProperty.call(input, nextKey)) {
      changed = true;
      continue;
    }
    const opaque =
      key === 'settings' &&
      Object.prototype.hasOwnProperty.call(input, 'manifest') &&
      Object.prototype.hasOwnProperty.call(input, 'digest');
    let next = opaque ? raw : normalizeBrandRecord(raw, seen, depth + 1);
    if (
      typeof next === 'string' &&
      !isStableLegacyIdentity(next) &&
      ['extensionId', 'definitionId', 'workflowDefinitionId', 'providerId', 'id'].includes(key)
    ) {
      next = next.replace(/^(?:moya|noveldesk)\./, 'boaa.');
    }
    if (key === 'format' && isBrandValue(next, 'boaa.extension.repository')) next = 'boaa.extension.repository';
    if (key === 'key' && typeof next === 'string') next = canonicalKey(next);
    if (key === 'packageFormat' && isBrandValue(next, 'boaa.extension.package')) next = 'boaa.extension.package';
    if (key === 'kind' && isBrandValue(next, 'boaa-js')) next = 'boaa-js';
    Object.defineProperty(output, nextKey, { value: next, enumerable: true, writable: true, configurable: true });
    changed ||= nextKey !== key || next !== raw;
  }
  return changed ? (output as T) : value;
}

export interface BrandStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

function normalizedStorageValue(value: string): string {
  if (!/^\s*(?:\[|{)/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    const next = normalizeBrandRecord(parsed);
    return next === parsed ? value : JSON.stringify(next);
  } catch {
    return value;
  }
}

export function readBrandStorage(storage: BrandStorage | null | undefined, key: string): string | null {
  if (!storage) return null;
  const current = storage.getItem(key);
  const aliases = legacyBrandNames(key);
  const oldKey = current === null ? aliases.find((alias) => storage.getItem(alias) !== null) : undefined;
  const raw = current ?? (oldKey ? storage.getItem(oldKey) : null);
  if (raw === null) return null;
  const next = normalizedStorageValue(raw);
  if (oldKey || next !== raw) {
    try {
      if (storage.setItem) {
        storage.setItem(key, next);
        if (storage.getItem(key) === next && oldKey) storage.removeItem?.(oldKey);
      }
    } catch {
      /* Read the original data when storage is read-only or quota is exhausted. */
    }
  }
  return next;
}

export function writeBrandStorage(
  storage: Pick<BrandStorage, 'setItem' | 'removeItem'> | null | undefined,
  key: string,
  value: string,
): void {
  if (!storage?.setItem) return;
  storage.setItem(key, value);
  for (const alias of legacyBrandNames(key)) storage.removeItem?.(alias);
}

export function removeBrandStorage(storage: Pick<BrandStorage, 'removeItem'> | null | undefined, key: string): void {
  storage?.removeItem?.(key);
  for (const alias of legacyBrandNames(key)) storage?.removeItem?.(alias);
}

/** A defined empty BOAA value is intentional; do not revive a previous secret/configuration. */
export function brandEnvironment<T extends Record<string, string | undefined>>(env: T): T {
  const result = { ...env };
  for (const prefix of ['MOYA', 'NOVELDESK', 'MOA'])
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(`${prefix}_`)) continue;
      const canonical = key.replace(/^(?:MOYA|NOVELDESK|MOA)_/, 'BOAA_');
      if (canonical !== key && result[canonical] === undefined) {
        (result as Record<string, string | undefined>)[canonical] = value;
      }
    }
  return result;
}

export function migrateBrandStorage(
  storage: BrandStorage & { readonly length: number; key(index: number): string | null },
): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key && /^(?:boaa|moya|noveldesk|moa)\.uiNext$/.test(key)) {
      storage.removeItem?.(key);
      continue;
    }
    if (!key || isStableLegacyIdentity(key)) continue;
    const canonical = key.replace(/^(?:moya|noveldesk|moa)(?=[._:-])/, 'boaa');
    if (canonical !== key) readBrandStorage(storage, canonical);
  }
}

export function isBoaaExtensionFilename(name: string): boolean {
  return /\.(?:boaaext|moyaext)$/i.test(name);
}
