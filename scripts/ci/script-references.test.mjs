import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

test('script UI imports resolve, including imports inside browser fixture strings', () => {
  const missing = [];
  for (const file of filesIn(path.join(root, 'scripts'))) {
    if (!/\.(?:mjs|cjs|js|ts|tsx)$/.test(file) || /\.(?:test|spec)\./.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])([^'"\n]+)\1/g)) {
      const specifier = match[2];
      if (!/(?:^|\/)src\/(?:ui-next|features|shared|components)\//.test(specifier)) continue;
      // Browser fixtures use Vite's /src root, ./src from a virtual root entry,
      // or a template interpolation naming the repository root.
      const resolved = specifier.replace(/^\$\{[^}]+\}(?=\/src\/)/, root.replace(/\/$/, ''));
      if (resolved.includes('${')) continue;
      const modulePath = resolved.replace(/[?#].*$/, '');
      const candidate = /^(?:\.\/|\/)src\//.test(modulePath)
        ? path.join(root, modulePath.replace(/^\.?\//, ''))
        : path.resolve(path.dirname(file), modulePath);
      const extensions = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '.css', '/index.ts', '/index.tsx'];
      if (!extensions.some((extension) => existsSync(candidate + extension))) {
        const line = source.slice(0, match.index).split('\n').length;
        missing.push(`${path.relative(root, file)}:${line}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('workflow package commands and repository file entrypoints exist', () => {
  const packagePath = path.join(root, 'package.json');
  const scripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts;
  const workflows = filesIn(path.join(root, '.github/workflows')).filter((file) => /\.ya?ml$/.test(file));
  const missing = [];
  for (const file of [packagePath, ...workflows]) {
    const source = readFileSync(file, 'utf8');
    if (file !== packagePath) {
      for (const [, command] of source.matchAll(/\bpnpm\s+(?:run\s+)?([\w-]+:[\w:-]+)/g)) {
        if (!Object.hasOwn(scripts, command)) missing.push(`${path.relative(root, file)}: ${command}`);
      }
    }
    for (const [, entrypoint] of source.matchAll(
      /(?<![\w./-])((?:scripts|src)\/[\w./-]+\.(?:mjs|cjs|js|tsx?|json))\b/g,
    )) {
      if (!existsSync(path.join(root, entrypoint))) missing.push(`${path.relative(root, file)}: ${entrypoint}`);
    }
  }
  assert.deepEqual(missing, []);
});
