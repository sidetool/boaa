import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, VITE_READER_BACKEND: 'remote', VITE_API_BASE_URL: '/api' };
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'],
  ['node_modules/vite/bin/vite.js', 'build'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeFileSync(
  new URL('../dist/hosted-build.json', import.meta.url),
  JSON.stringify({ backend: 'remote', apiBaseUrl: '/api' }) + '\n',
);
