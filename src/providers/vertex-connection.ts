export const VERTEX_JSON_MAX_BYTES = 65536;
export const vertexProjectValid = (value: string) => /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value);
export const vertexLocationValid = (value: string) => /^(?:global|us|eu|[a-z]+(?:-[a-z]+)+[0-9])$/.test(value);

/** Vertex OAuth tokens only go to Google-owned endpoints constructed from validated identifiers. */
export function vertexBaseUrl(project: string, location: string): string {
  if (!vertexProjectValid(project) || !vertexLocationValid(location)) throw new Error('Invalid Vertex destination');
  const host =
    location === 'global'
      ? 'aiplatform.googleapis.com'
      : location === 'us' || location === 'eu'
        ? `aiplatform.${location}.rep.googleapis.com`
        : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`;
}

/** Browser shape check only. The server additionally validates the RSA key and strips extra credential fields. */
export function inspectVertexJson(text: string): { projectId: string } | { error: string } {
  if (new TextEncoder().encode(text).length > VERTEX_JSON_MAX_BYTES)
    return { error: 'JSON 파일은 64 KiB 이하여야 해요.' };
  try {
    const value = JSON.parse(text);
    if (
      value?.type !== 'service_account' ||
      typeof value.project_id !== 'string' ||
      !vertexProjectValid(value.project_id) ||
      typeof value.client_email !== 'string' ||
      !value.client_email ||
      typeof value.private_key !== 'string' ||
      !value.private_key
    )
      return { error: 'Google Cloud 서비스 계정 JSON 키 파일을 골라 주세요.' };
    return { projectId: value.project_id };
  } catch {
    return { error: 'JSON 형식이 올바르지 않아요.' };
  }
}
