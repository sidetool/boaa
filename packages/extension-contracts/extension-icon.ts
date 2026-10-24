/** Decorative metadata never authorizes source requests or executable content. */
export function extensionIconUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
