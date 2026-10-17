import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** Measure emitted bytes, not runtime memory or network transfer timing. */
export function inventoryWebBundle(distRoot) {
  const manifestPath = path.join(distRoot, '.vite/manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Vite manifest is missing; build with --manifest first.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const initial = new Set();
  const deferred = new Set();
  const assets = new Set();
  const visited = new Set();
  const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
  if (!entries.length) throw new Error('No entry was found in the Vite manifest.');

  function walk(key, target, seen) {
    if (seen.has(key)) return;
    seen.add(key);
    if (!Object.hasOwn(manifest, key)) throw new Error(`Unknown manifest import: ${key}`);
    const chunk = manifest[key];
    if (/\.(?:[cm]?js|css)$/.test(chunk.file)) target.add(chunk.file);
    else assets.add(chunk.file);
    for (const file of chunk.css ?? []) target.add(file);
    for (const file of chunk.assets ?? []) assets.add(file);
    for (const imported of chunk.imports ?? []) walk(imported, target, seen);
  }

  for (const entry of entries) walk(entry, initial, visited);
  // Include every emitted lazy chunk, including its static dependencies. Shared
  // chunks already needed by an entry belong to initial only.
  const deferredVisited = new Set();
  for (const key of Object.keys(manifest)) walk(key, deferred, deferredVisited);
  for (const file of initial) deferred.delete(file);
  for (const file of [...initial, ...deferred]) assets.delete(file);

  function measure(file) {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`Invalid manifest asset path: ${file}`);
    }
    const content = fs.readFileSync(path.join(distRoot, file));
    return { path: file, raw: content.byteLength, gzip: gzipSync(content, { level: 9 }).byteLength };
  }
  function group(files) {
    const measured = [...files].sort().map(measure);
    return {
      files: measured,
      js: totals(measured.filter((file) => /\.[cm]?js$/.test(file.path))),
      css: totals(measured.filter((file) => file.path.endsWith('.css'))),
      all: totals(measured),
    };
  }
  return { schemaVersion: 1, entries, initial: group(initial), deferred: group(deferred), assets: group(assets) };
}

function totals(files) {
  return files.reduce((sum, file) => ({ raw: sum.raw + file.raw, gzip: sum.gzip + file.gzip }), { raw: 0, gzip: 0 });
}
