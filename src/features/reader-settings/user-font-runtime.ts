import type { UserFontAsset } from '../../domain/types';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';

type LoadedFont = { hash: string; face: FontFace; url: string; family: string };
const repositories = new WeakMap<ReaderPersonalizationRepository, { fonts: Map<string, LoadedFont>; nonce: string }>();
function fontsFor(repository: ReaderPersonalizationRepository) {
  repository.signal?.throwIfAborted();
  let state = repositories.get(repository);
  if (!state) {
    state = { fonts: new Map(), nonce: crypto.randomUUID() };
    repositories.set(repository, state);
    repository.signal?.addEventListener(
      'abort',
      () => {
        for (const id of state!.fonts.keys()) unloadUserFont(id, repository);
        repositories.delete(repository);
      },
      { once: true },
    );
  }
  return state;
}

export async function loadUserFont(
  repository: ReaderPersonalizationRepository | undefined,
  asset: UserFontAsset | undefined,
): Promise<string | undefined> {
  if (!repository || !asset || typeof FontFace === 'undefined' || !globalThis.document?.fonts) return undefined;
  const state = fontsFor(repository);
  const existing = state.fonts.get(asset.id);
  if (existing?.hash === asset.contentHash) return `"${existing.family}"`;
  if (existing) unloadUserFont(asset.id, repository);
  const blob = await repository.getUserFontContent(asset.id);
  repository.signal?.throwIfAborted();
  if (!blob) throw new Error('font_content_missing');
  const url = URL.createObjectURL(blob);
  const family = `Boaa User ${state.nonce} ${asset.id}`;
  const face = new FontFace(family, `url("${url}")`, { style: asset.style, weight: String(asset.weight) });
  try {
    await face.load();
    repository.signal?.throwIfAborted();
    // A concurrent load for this repository/id may have finished first.
    unloadUserFont(asset.id, repository);
    document.fonts.add(face);
    state.fonts.set(asset.id, { hash: asset.contentHash, face, url, family });
    return `"${family}"`;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function unloadUserFont(id: string, repository: ReaderPersonalizationRepository): void {
  const fonts = repositories.get(repository)?.fonts;
  const loaded = fonts?.get(id);
  if (!loaded) return;
  document.fonts.delete(loaded.face);
  URL.revokeObjectURL(loaded.url);
  fonts!.delete(id);
}

export function builtinFontFamily(fontId: string): string | undefined {
  if (fontId === 'builtin-sans') return 'var(--font-sans)';
  if (fontId === 'builtin-mono') return 'var(--font-mono)';
  if (fontId === 'builtin-serif') return 'var(--font-serif)';
  return undefined;
}
