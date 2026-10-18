import { afterEach, expect, it, vi } from 'vitest';
import { loadUserFont } from './user-font-runtime';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { UserFontAsset } from '../../domain/types';

const asset = { id: 'same-font', contentHash: 'same-hash', style: 'normal', weight: 400 } as UserFontAsset;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('keeps identical font IDs in separate repositories and removes faces on logout', async () => {
  const fonts = { add: vi.fn(), delete: vi.fn() };
  vi.stubGlobal('document', { fonts });
  vi.stubGlobal(
    'FontFace',
    class {
      async load() {
        return this;
      }
    },
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const a = new AbortController(),
    b = new AbortController();
  const repoA = {
    signal: a.signal,
    getUserFontContent: vi.fn().mockResolvedValue(new Blob(['a'])),
  } as unknown as ReaderPersonalizationRepository;
  const repoB = {
    signal: b.signal,
    getUserFontContent: vi.fn().mockResolvedValue(new Blob(['b'])),
  } as unknown as ReaderPersonalizationRepository;
  const familyA = await loadUserFont(repoA, asset);
  const familyB = await loadUserFont(repoB, asset);
  expect(familyA).not.toBe(familyB);
  expect(repoB.getUserFontContent).toHaveBeenCalledWith(asset.id);
  a.abort();
  expect(fonts.delete).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(await loadUserFont(repoB, asset)).toBe(familyB);
  await expect(loadUserFont(repoA, asset)).rejects.toMatchObject({ name: 'AbortError' });
});
it('does not install a font when its load finishes after logout', async () => {
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fonts = { add: vi.fn(), delete: vi.fn() };
  vi.stubGlobal('document', { fonts });
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        return loaded;
      }
    },
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:delayed-fixture');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const controller = new AbortController();
  const repository = {
    signal: controller.signal,
    getUserFontContent: vi.fn().mockResolvedValue(new Blob(['a'])),
  } as unknown as ReaderPersonalizationRepository;
  const result = loadUserFont(repository, asset);
  await Promise.resolve();
  controller.abort();
  finish();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(fonts.add).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith('blob:delayed-fixture');
});
