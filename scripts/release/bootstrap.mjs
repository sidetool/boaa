import { randomBytes } from 'node:crypto';
import { chmod, chown, lstat, mkdir, open, readFile } from 'node:fs/promises';

// Fixed named-volume location; no credential is accepted over HTTP or printed.
const directory = '/run/secrets';
const file = directory + '/boaa-runtime-token';
await mkdir(directory, { recursive: true, mode: 0o700 });
const stat = await lstat(file).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('runtime_token_invalid');
if (!stat) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(randomBytes(32).toString('hex'));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
if (!/^[a-f0-9]{64}$/.test(await readFile(file, 'utf8'))) throw new Error('runtime_token_invalid');
await chown(file, 1000, 1000);
await chown(directory, 1000, 1000);
await chmod(file, 0o600);
await chmod(directory, 0o700);
