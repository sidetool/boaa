import type { FileEntry } from '@zip.js/zip.js';
import { isBoaaPackagePath, BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';

export class BoaaPackageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BoaaPackageError';
  }
}

export interface VerifiedPackageArchive<T> {
  readonly digest: string;
  readonly manifest: T;
  readonly publisherFingerprint?: string;
  readonly source: string;
  readonly archive: Blob;
}

interface IntegrityFile {
  path: string;
  sha256: string;
  size: number;
}
export const INTEGRITY_DOMAIN = 'moya.extension.package/integrity/v1\n';

export async function packageSha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalIntegrity(files: readonly IntegrityFile[]): string {
  return `${JSON.stringify({ schemaVersion: 1, files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(({ path, sha256, size }) => ({ path, sha256, size })) })}\n`;
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BoaaPackageError('invalid_package_encoding');
  }
}

function metadata(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > BOAA_PACKAGE_LIMITS.manifestBytes) throw new BoaaPackageError('package_limit');
  const value: unknown = JSON.parse(text(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BoaaPackageError('invalid_package_metadata');
  return value as Record<string, unknown>;
}

function allowedFile(path: string, entryPaths: readonly string[]): boolean {
  return (
    [
      'manifest.json',
      'integrity.json',
      'signatures/publisher.json',
      ...entryPaths,
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ].includes(path) || /^assets\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(path)
  );
}

async function readEntry(entry: FileEntry, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > max)
    throw new BoaaPackageError('package_limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(chunk) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > max || size > entry.uncompressedSize) throw new BoaaPackageError('package_limit');
        chunks.push(chunk.slice());
      },
    }),
    { signal, checkSignature: true, useWebWorkers: false },
  );
  if (size !== entry.uncompressedSize) throw new BoaaPackageError('invalid_package_size');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function verifyPublisher(bytes: Uint8Array, integrity: string): Promise<string> {
  const value = metadata(bytes);
  if (
    Object.keys(value).sort().join(',') !== 'algorithm,publicKey,schemaVersion,signature' ||
    value.schemaVersion !== 1 ||
    value.algorithm !== 'ECDSA-P256-SHA256' ||
    typeof value.publicKey !== 'string' ||
    value.publicKey.length > 512 ||
    typeof value.signature !== 'string' ||
    value.signature.length > 128
  )
    throw new BoaaPackageError('invalid_package_signature');
  const decode = (value: string) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BoaaPackageError('invalid_package_signature');
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  };
  const publicKey = decode(value.publicKey);
  const signature = decode(value.signature);
  if (signature.length !== 64) throw new BoaaPackageError('invalid_package_signature');
  const key = await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    new TextEncoder().encode(INTEGRITY_DOMAIN + integrity),
  );
  if (!valid) throw new BoaaPackageError('invalid_package_signature');
  return packageSha256(publicKey);
}

/** No code execution, writes, global trust changes or network requests occur during preflight. */
export async function verifyPackageArchive<T>(
  archive: Blob,
  profile: {
    entry: 'dist/main.js' | 'dist/ui.js' | readonly string[];
    parseManifest?: (text: string) => unknown;
    declaredEntries?: (manifest: T) => readonly string[];
    validate: (value: unknown) => { ok: true; manifest: T } | { ok: false; code: string };
  },
  signal?: AbortSignal,
): Promise<VerifiedPackageArchive<T> & { readonly sources: Readonly<Record<string, string>> }> {
  const entryPaths = typeof profile.entry === 'string' ? [profile.entry] : profile.entry;
  signal?.throwIfAborted();
  if (archive.size === 0 || archive.size > BOAA_PACKAGE_LIMITS.archiveBytes)
    throw new BoaaPackageError('package_limit');
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  signal?.throwIfAborted();
  const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
  try {
    const files = new Map<string, Uint8Array>();
    const names = new Set<string>();
    let count = 0;
    let expanded = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > BOAA_PACKAGE_LIMITS.entries) throw new BoaaPackageError('package_limit');
      const path = entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        !isBoaaPackagePath(path) ||
        names.has(path.toLowerCase()) ||
        entry.encrypted ||
        (mode !== 0 && mode !== (entry.directory ? 0x4000 : 0x8000))
      )
        throw new BoaaPackageError('invalid_package_entry');
      names.add(path.toLowerCase());
      if (entry.directory) {
        if (!['dist', 'assets', 'signatures'].includes(path) || entry.uncompressedSize !== 0)
          throw new BoaaPackageError('invalid_package_entry');
        continue;
      }
      if (!allowedFile(path, entryPaths)) throw new BoaaPackageError('invalid_package_entry');
      const maximum = path.endsWith('.json')
        ? BOAA_PACKAGE_LIMITS.manifestBytes
        : entryPaths.includes(path)
          ? BOAA_PACKAGE_LIMITS.entryBytes
          : BOAA_PACKAGE_LIMITS.expandedBytes;
      expanded += entry.uncompressedSize;
      if (expanded > BOAA_PACKAGE_LIMITS.expandedBytes) throw new BoaaPackageError('package_limit');
      files.set(path, await readEntry(entry, Math.min(maximum, BOAA_PACKAGE_LIMITS.expandedBytes), signal));
    }
    for (const required of ['manifest.json', 'integrity.json', 'LICENSE']) {
      if (!files.has(required)) throw new BoaaPackageError('incomplete_package');
    }
    const manifest = profile.validate(
      profile.parseManifest
        ? profile.parseManifest(text(files.get('manifest.json')!))
        : metadata(files.get('manifest.json')!),
    );
    if (!manifest.ok) throw new BoaaPackageError(manifest.code);
    const declared = profile.declaredEntries?.(manifest.manifest) ?? entryPaths;
    for (const path of declared) {
      if (!entryPaths.includes(path) || !files.has(path)) throw new BoaaPackageError('incomplete_package');
    }
    if (entryPaths.some((path) => files.has(path) && !declared.includes(path)))
      throw new BoaaPackageError('undeclared_package_entry');
    const sources = Object.fromEntries(declared.map((path) => [path, text(files.get(path)!)]));
    const integrity = metadata(files.get('integrity.json')!);
    if (
      integrity.schemaVersion !== 1 ||
      !Array.isArray(integrity.files) ||
      integrity.files.length > BOAA_PACKAGE_LIMITS.entries
    )
      throw new BoaaPackageError('invalid_package_integrity');
    const expected: IntegrityFile[] = [];
    for (const [path, bytes] of files) {
      if (path === 'integrity.json' || path === 'signatures/publisher.json') continue;
      signal?.throwIfAborted();
      expected.push({ path, sha256: await packageSha256(bytes), size: bytes.length });
    }
    // Exact canonical comparison rejects missing/extra files, duplicate entries, wrong hashes/sizes and hidden fields.
    const canonical = canonicalIntegrity(expected);
    if (text(files.get('integrity.json')!) !== canonical) throw new BoaaPackageError('invalid_package_integrity');
    const publisher = files.get('signatures/publisher.json');
    const publisherFingerprint = publisher ? await verifyPublisher(publisher, canonical) : undefined;
    const digest = await packageSha256(new Uint8Array(await archive.arrayBuffer()));
    signal?.throwIfAborted();
    return {
      digest,
      manifest: manifest.manifest,
      publisherFingerprint,
      source: sources[declared[0]] ?? '',
      sources,
      archive,
    };
  } catch (error) {
    if (signal?.aborted) throw new BoaaPackageError('cancelled');
    if (error instanceof BoaaPackageError) throw error;
    throw new BoaaPackageError('invalid_package');
  } finally {
    await reader.close();
  }
}
