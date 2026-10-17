import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

const licenseNoticeAssets = [
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['third_party/licenses/7z-wasm/License.txt', 'third_party/licenses/7z-wasm/License.txt'],
  ['third_party/licenses/common/LGPL-2.1.txt', 'third_party/licenses/common/LGPL-2.1.txt'],
  ['third_party/licenses/common/unRarLicense.txt', 'third_party/licenses/common/unRarLicense.txt'],
  ['third_party/licenses/node-unrar-js/LICENSE.md', 'third_party/licenses/node-unrar-js/LICENSE.md'],
] as const;

function packageLicenseNotices(): Plugin {
  return {
    name: 'boaa-license-notices',
    apply: 'build',
    generateBundle() {
      for (const [sourcePath, fileName] of licenseNoticeAssets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(sourcePath) });
      }
    },
  };
}

// Record actual bundled package inputs; full build notices remain a conservative superset.
function webComponentEvidence(): Plugin {
  return {
    name: 'boaa-web-component-evidence',
    apply: 'build',
    generateBundle() {
      const components = new Map<string, { name: string; version: string; license?: string }>();
      for (const id of this.getModuleIds()) {
        if (!id.includes('/node_modules/')) continue;
        let folder = dirname(id.split('?')[0]);
        while (folder !== dirname(folder)) {
          const manifest = join(folder, 'package.json');
          if (existsSync(manifest)) {
            const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
            if (metadata.name && metadata.version) {
              components.set(`${metadata.name}@${metadata.version}`, {
                name: metadata.name,
                version: metadata.version,
                license: metadata.license,
              });
              break;
            }
          }
          folder = dirname(folder);
        }
      }
      const source =
        JSON.stringify(
          { format: 1, components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)) },
          null,
          2,
        ) + '\n';
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: `licenses/web-${hash}-inventory.json`, source });
    },
  };
}

export default defineConfig({
  plugins: [react(), packageLicenseNotices(), webComponentEvidence()],
  clearScreen: false,
  build: { manifest: true },
  server: {
    strictPort: true,
    port: 1421,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  worker: {
    format: 'es',
    plugins: () => [webComponentEvidence()],
  },
  test: {
    exclude: [...configDefaults.exclude, 'handoff/**', '.tmp/**', 'scripts/public-release-sync.test.mjs'],
  },
});
