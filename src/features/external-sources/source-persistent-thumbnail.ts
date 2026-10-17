export async function persistentThumbnailUrl(value: string | undefined): Promise<string | undefined> {
  if (!value || !value.startsWith('blob:')) return value;
  try {
    const response = await fetch(value);
    if (!response.ok) return undefined;
    const { MAX_SOURCE_COVER_BYTES, sourceCoverContentType } = await import('./source-cover');
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_COVER_BYTES) return undefined;
    const blob = await response.blob();
    const contentType = sourceCoverContentType(blob.type || response.headers.get('Content-Type') || '');
    if (!contentType || blob.size === 0 || blob.size > MAX_SOURCE_COVER_BYTES) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}
