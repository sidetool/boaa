import { describe, expect, it } from 'vitest';
import { extensionIconUrl } from './extension-icon';
import { mangaApkIconUrl } from './apk-repository';
import { parseMangayomiIndex } from './compatibility-repository';
import { repositoryIconUrl, validateRepositoryIndex } from '../../src/extensions/packages/repository-contract';
describe('extension repository artwork', () => {
  it('keeps optional Mangayomi icons, resolves relative paths, and ignores unsafe decorative URLs', () => {
    const row = {
      id: 1,
      name: 'Fixture',
      lang: 'en',
      version: '1.0',
      baseUrl: 'https://source.example',
      sourceCodeUrl: 'https://repo.example/sources/source.js',
      sourceCodeLanguage: 1,
    };
    expect(parseMangayomiIndex([{ ...row, iconUrl: '../icons/source.png' }])[0].iconUrl).toBe(
      'https://repo.example/icons/source.png',
    );
    for (const iconUrl of [
      'javascript:alert(1)',
      'data:image/svg+xml,example',
      'https://user:pass@repo.example/icon.png',
      'http://repo.example/icon.png',
    ]) {
      expect(extensionIconUrl(iconUrl)).toBeUndefined();
      expect(parseMangayomiIndex([{ ...row, iconUrl }])[0].iconUrl).toBeUndefined();
    }
    expect(parseMangayomiIndex([row])[0].iconUrl).toBeUndefined();
  });
  it('derives APK icons from the package ID within the repository directory', () => {
    expect(mangaApkIconUrl('https://repo.example/extensions/index.min.json', 'org.example.source')).toBe(
      'https://repo.example/extensions/icon/org.example.source.png',
    );
    expect(mangaApkIconUrl('https://repo.example', '../source')).toBeUndefined();
  });
  it('allows native optional icons only on the selected repository origin', () => {
    const url = 'https://repo.example/catalog/index.json';
    const entry = { id: 'org.example.source', version: '1.0.0', archive: 'source.boaaext', sha256: 'a'.repeat(64) };
    const index = { format: 'boaa.extension.repository', version: 1, packages: [entry] };
    expect(validateRepositoryIndex(index, url).packages[0]).toEqual(entry);
    expect(repositoryIconUrl('./icons/source.png', url)).toBe('https://repo.example/catalog/icons/source.png');
    expect(
      validateRepositoryIndex({ ...index, packages: [{ ...entry, iconUrl: './icons/source.png' }] }, url).packages[0]
        .iconUrl,
    ).toBe('./icons/source.png');
    for (const iconUrl of [
      'https://elsewhere.example/icon.png',
      'data:image/png,abc',
      'https://user@repo.example/icon.png',
    ])
      expect(() => validateRepositoryIndex({ ...index, packages: [{ ...entry, iconUrl }] }, url)).toThrow();
  });
});
