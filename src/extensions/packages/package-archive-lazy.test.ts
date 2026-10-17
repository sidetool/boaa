import { afterEach, expect, it, vi } from 'vitest';
import { packageSha256, verifyPackageArchive } from './package-archive-core';

const profile = {
  entry: 'dist/main.js' as const,
  validate: (_value: unknown) => ({ ok: true as const, manifest: {} }),
};
afterEach(() => {
  vi.doUnmock('@zip.js/zip.js');
  vi.resetModules();
});

it('keeps package hashing available when the ZIP chunk fails to load', async () => {
  vi.doMock('@zip.js/zip.js', () => {
    throw new Error('synthetic ZIP load failure');
  });
  await expect(packageSha256(new Uint8Array())).resolves.toHaveLength(64);
  await expect(verifyPackageArchive(new Blob(['zip']), profile)).rejects.toMatchObject({
    cause: new Error('synthetic ZIP load failure'),
  });
});

it('checks cancellation after loading ZIP and before creating a reader', async () => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reader = vi.fn();
  vi.doMock('@zip.js/zip.js', async () => {
    started();
    await loaded;
    return { BlobReader: vi.fn(), ZipReader: reader };
  });
  const controller = new AbortController();
  const pending = verifyPackageArchive(new Blob(['zip']), profile, controller.signal);
  await loading;
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(reader).not.toHaveBeenCalled();
});
