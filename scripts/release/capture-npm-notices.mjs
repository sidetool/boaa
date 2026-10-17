// Preserve notices for bundled dependencies that an image/package scanner cannot see after bundling.
import { readdir, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve(process.argv[2] || '/tmp/boaa-npm-notices');
await mkdir(output, { recursive: true });
const packages = new Map();
async function inspect(directory) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  if (!metadata.name || !metadata.version) return;
  const id = `${metadata.name}@${metadata.version}`;
  if (packages.has(id)) return;
  const target = path.join(output, encodeURIComponent(id));
  await mkdir(target, { recursive: true });
  const notices = [];
  async function collect(folder, depth) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
      const source = path.join(folder, entry.name);
      if (
        entry.isFile() &&
        /^(licen[cs]e|copying|copyright|notice|third[-_]?party(?:notices?)?)([._-]|$)/i.test(entry.name)
      ) {
        const relative = path.relative(directory, source);
        const destination = path.join(target, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        notices.push(relative);
      } else if (
        entry.isDirectory() &&
        depth > 0 &&
        /^(licen[cs]es?|legal|third[-_]?party(?:notices?)?)$/i.test(entry.name)
      ) {
        await collect(source, depth - 1);
      }
    }
  }
  await collect(directory, 3);
  packages.set(id, {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license || metadata.licenses,
    repository: metadata.repository,
    notices,
  });
}
async function modules(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(folder, entry.name)).catch(() => []))
        await inspect(path.join(folder, entry.name, child));
    } else if (!entry.name.startsWith('.')) await inspect(path.join(folder, entry.name));
  }
}
await modules('node_modules');
for (const entry of await readdir('node_modules/.pnpm').catch(() => []))
  await modules(path.join('node_modules/.pnpm', entry, 'node_modules'));
await writeFile(path.join(output, 'inventory.json'), JSON.stringify([...packages.values()], null, 2) + '\n');
console.log(`Preserved notices/metadata for ${packages.size} build dependencies (a conservative superset).`);
