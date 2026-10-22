// Check the final bundle's component-to-notice mapping before native image builds.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
      }),
    )
  ).flat();
}

export async function checkWebNotices({ dist, npmNotices, root = process.cwd() }) {
  const distFiles = await files(dist);
  const inventories = distFiles.filter((file) => /\/web-[a-f0-9]+-inventory\.json$/.test(file));
  if (!inventories.length) throw new Error('web_component_inventory_missing');
  const noticeFiles = [
    ...distFiles,
    ...(await files(npmNotices)),
    ...(await files(path.join(root, 'third_party/licenses'))),
  ].filter(
    (file) =>
      /^(licen[cs]e|copying|copyright|notice|third[-_]?party)([._-]|$)/i.test(path.basename(file)) ||
      file.includes('/third_party/licenses/'),
  );
  const hashes = new Set(
    await Promise.all(
      noticeFiles.map(async (file) =>
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ),
    ),
  );
  const records = JSON.parse(
    await readFile(path.join(root, 'third_party/server-component-evidence.json'), 'utf8'),
  ).components;
  const missing = new Set();
  const checked = new Set();
  for (const inventory of inventories) {
    for (const row of JSON.parse(await readFile(inventory, 'utf8')).components) {
      const identity = `${row.name}@${row.version}`;
      checked.add(identity);
      const record = records.find(
        (entry) => entry.ecosystem === 'npm' && entry.name === row.name && entry.version === row.version,
      );
      const folder = encodeURIComponent(identity) + path.sep;
      const ownNotice = noticeFiles.some(
        (file) =>
          file.startsWith(path.join(npmNotices, folder)) || file.startsWith(path.join(dist, 'licenses/npm', folder)),
      );
      const mappedNotice = record?.notices.some((notice) => hashes.has(notice.sha256));
      const internal = row.name.startsWith('@boaa/') && (await readFile(path.join(root, 'LICENSE'))).length > 0;
      if (!(internal || ((row.license || record?.licenses?.length) && (ownNotice || mappedNotice))))
        missing.add(identity);
    }
  }
  if (missing.size) throw new Error(`web_component_notice_missing: ${[...missing].sort().join(', ')}`);
  return checked.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await checkWebNotices({
    dist: path.resolve(process.argv[2] || 'dist'),
    npmNotices: path.resolve(process.argv[3] || '.tmp/release-npm-notices'),
  });
  console.log(`Web bundle notice mapping PASS: ${count} components`);
}
